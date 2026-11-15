package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const directoryPageSize = 15
const maxCategoryPages = 1000

type directoryPage struct {
	Rooms  []rawCategoryRoom
	Count  int
	Offset int
}

type directoryJob struct {
	Category categoryOutput
	Offset   int
}

type directoryResult struct {
	Job   directoryJob
	Page  directoryPage
	Error error
}

type directoryFetcher func(context.Context, categoryOutput, int) (directoryPage, error)

// Schedule one page at a time across categories. A large category cannot starve
// the first page of another category before the overall sync deadline.
func collectDirectory(ctx context.Context, categories []categoryOutput, workers int, leafIDByName map[string]string, source string, fetch directoryFetcher) allRoomsResponse {
	jobs := make(chan directoryJob)
	results := make(chan directoryResult, workers)
	for i := 0; i < workers; i++ {
		go func() {
			for job := range jobs {
				page, err := fetch(ctx, job.Category, job.Offset)
				results <- directoryResult{job, page, err}
			}
		}()
	}
	defer close(jobs)
	queue := make([]directoryJob, 0, len(categories))
	for _, category := range categories {
		queue = append(queue, directoryJob{Category: category})
	}
	roomsByID := make(map[string]roomOutput)
	seenByCategory := make(map[string]map[string]bool)
	pagesByCategory := make(map[string]int)
	finished := make(map[string]bool)
	failures := make(map[string]categoryFailure)
	leafIDs := make(map[string]struct{})
	for _, id := range leafIDByName {
		leafIDs[id] = struct{}{}
	}
	full := source == "douyin-category-aggregation"
	active, pagesFetched := 0, 0
	fail := func(category categoryOutput, err error) {
		failures[category.ID] = categoryFailure{category.ID, category.Name, err.Error()}
	}
	for len(queue) > 0 || active > 0 {
		if ctx.Err() != nil {
			for _, job := range queue {
				fail(job.Category, ctx.Err())
			}
			queue = nil
		}
		if len(queue) == 0 && active == 0 {
			break
		}
		var send chan directoryJob
		var next directoryJob
		if len(queue) > 0 {
			send, next = jobs, queue[0]
		}
		select {
		case send <- next:
			queue = queue[1:]
			active++
		case result := <-results:
			active--
			category, page := result.Job.Category, result.Page
			if seenByCategory[category.ID] == nil {
				seenByCategory[category.ID] = make(map[string]bool)
			}
			seen := seenByCategory[category.ID]
			added := 0
			for _, raw := range page.Rooms {
				room := mapRoom(raw, category, leafIDByName)
				if room.ID == "" || room.DouyinID == "" {
					continue
				}
				if !seen[room.ID] {
					added++
					seen[room.ID] = true
				}
				if current, ok := roomsByID[room.ID]; ok {
					roomsByID[room.ID] = mergeRoomCopies(current, room, leafIDs)
				} else {
					roomsByID[room.ID] = room
				}
			}
			if page.Rooms != nil {
				pagesFetched++
				pagesByCategory[category.ID]++
			}
			if result.Error != nil {
				fail(category, result.Error)
				continue
			}
			if !full || page.Count < directoryPageSize {
				finished[category.ID] = true
				continue
			}
			if page.Offset <= result.Job.Offset || added == 0 {
				fail(category, fmt.Errorf("pagination stalled at offset %d", result.Job.Offset))
				continue
			}
			if pagesByCategory[category.ID] >= maxCategoryPages {
				fail(category, fmt.Errorf("pagination safety limit reached at offset %d", page.Offset))
				continue
			}
			queue = append(queue, directoryJob{category, page.Offset})
		}
	}
	rooms := make([]roomOutput, 0, len(roomsByID))
	for _, room := range roomsByID {
		rooms = append(rooms, room)
	}
	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].Viewers == rooms[j].Viewers {
			return rooms[i].ID < rooms[j].ID
		}
		return rooms[i].Viewers > rooms[j].Viewers
	})
	failed := make([]categoryFailure, 0, len(failures))
	for _, category := range categories {
		if failure, ok := failures[category.ID]; ok {
			failed = append(failed, failure)
		}
	}
	// The website's category navigation is a curated subset. Exhausting these
	// cursors proves coverage of that index, never of every Douyin live room.
	note := "公开分类列表，不代表抖音全站"
	if full && len(failed) == 0 {
		note = "已遍历公开分类分页，不代表抖音全站"
	}
	if full && len(failed) > 0 {
		names := make([]string, 0, len(failed))
		for _, failure := range failed {
			names = append(names, failure.Name)
		}
		note = fmt.Sprintf("%d 个分类分页未完成（%s），已保留获取到的房间", len(failed), strings.Join(names, "、"))
	}
	if !full {
		note = "公开分类热门采样，非完整列表"
	}
	return allRoomsResponse{
		Rooms: rooms, CategoryCount: len(categories), SuccessfulCategories: len(finished),
		FailedCategories: failed, Partial: len(failed) > 0 || ctx.Err() != nil,
		Source: source, Complete: false, CoverageNote: note, PagesFetched: pagesFetched,
	}
}

func fetchDirectoryPage(ctx context.Context, category categoryOutput, offset int) (directoryPage, error) {
	var page directoryPage
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		page, err = fetchDirectoryAPI(ctx, category, offset)
		if err == nil || ctx.Err() != nil {
			break
		}
		if attempt < 2 {
			if retryErr := waitForRetry(ctx, time.Duration(attempt+1)*350*time.Millisecond); retryErr != nil {
				break
			}
		}
	}
	if err == nil || offset != 0 {
		return page, err
	}
	// A blocked page request is not an empty last page. Retain the HTML sample
	// while reporting the category as incomplete.
	var fallback rawCategoryPage
	if fallbackErr := fetchPageDataWithRetry(ctx, category.ID, "roomsData", &fallback); fallbackErr == nil {
		return directoryPage{fallback.RoomsData.Data, fallback.RoomsData.Count, fallback.RoomsData.Offset}, err
	}
	return directoryPage{}, err
}

func fetchDirectoryAPI(ctx context.Context, category categoryOutput, offset int) (directoryPage, error) {
	if err := waitForRequest(ctx); err != nil {
		return directoryPage{}, err
	}
	requestURL := os.Getenv("LIVEHUB_DOUYIN_PAGING_URL")
	if requestURL != "" {
		requestURL += "?" + url.Values{"category": {category.ID}, "offset": {strconv.Itoa(offset)}}.Encode()
	} else {
		parts := strings.Split(category.ID, "_")
		if len(parts) < 2 {
			return directoryPage{}, fmt.Errorf("invalid category %s", category.ID)
		}
		requestURL = "https://live.douyin.com/webcast/web/partition/detail/room/v2?" + url.Values{
			"aid": {"6383"}, "app_name": {"douyin_web"}, "live_id": {"1"}, "device_platform": {"web"},
			"language": {"zh-CN"}, "count": {"15"}, "offset": {strconv.Itoa(offset)},
			"partition": {parts[len(parts)-1]}, "partition_type": {parts[len(parts)-2]}, "req_from": {"2"},
		}.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return directoryPage{}, err
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Referer", "https://live.douyin.com/categorynew/"+category.ID)
	response, err := httpClient.Do(request)
	if err != nil {
		return directoryPage{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return directoryPage{}, fmt.Errorf("directory pagination HTTP %d", response.StatusCode)
	}
	var payload struct {
		StatusCode *int `json:"status_code"`
		Data       *struct {
			Count  *int               `json:"count"`
			Offset *int               `json:"offset"`
			Data   *[]rawCategoryRoom `json:"data"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 24<<20)).Decode(&payload); err != nil {
		return directoryPage{}, fmt.Errorf("directory pagination blocked or invalid JSON: %w", err)
	}
	if payload.StatusCode == nil || *payload.StatusCode != 0 || payload.Data == nil ||
		payload.Data.Count == nil || payload.Data.Offset == nil || payload.Data.Data == nil {
		return directoryPage{}, fmt.Errorf("directory pagination returned an invalid response")
	}
	data := payload.Data
	if *data.Count < 0 || *data.Offset < 0 || *data.Count != len(*data.Data) {
		return directoryPage{}, fmt.Errorf("directory pagination returned inconsistent count or cursor")
	}
	return directoryPage{*data.Data, *data.Count, *data.Offset}, nil
}
