package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	categoryRootID = "4_101"
	userAgent      = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
	defaultWorkers = 4
)

var httpClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     30 * time.Second,
		DisableCompression:  true,
		ForceAttemptHTTP2:   false,
	},
	Timeout: 30 * time.Second,
}

var requestGate = struct {
	sync.Mutex
	next time.Time
}{}

type categoryOutput struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type roomOutput struct {
	ID            string            `json:"id"`
	DouyinID      string            `json:"douyinId"`
	Title         string            `json:"title"`
	Anchor        string            `json:"anchor"`
	Category      string            `json:"category"`
	CategoryID    string            `json:"categoryId,omitempty"`
	Viewers       int               `json:"viewers"`
	ViewerLabel   string            `json:"viewerLabel"`
	Cover         string            `json:"cover"`
	WebURL        string            `json:"webUrl"`
	Status        string            `json:"status"`
	FlvStreamURLs map[string]string `json:"flvStreamUrls"`
	HlsStreamURLs map[string]string `json:"hlsStreamUrls"`
}

type categoryFailure struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error"`
}

type categoriesResponse struct {
	Categories []categoryOutput `json:"categories"`
}

type roomsResponse struct {
	Rooms []roomOutput `json:"rooms"`
}

type allRoomsResponse struct {
	Rooms                []roomOutput      `json:"rooms"`
	CategoryCount        int               `json:"categoryCount"`
	SuccessfulCategories int               `json:"successfulCategories"`
	FailedCategories     []categoryFailure `json:"failedCategories,omitempty"`
	Partial              bool              `json:"partial"`
	Source               string            `json:"source"`
}

type rawCategory struct {
	Partition struct {
		IDStr string `json:"id_str"`
		Type  int    `json:"type"`
		Title string `json:"title"`
	} `json:"partition"`
	SubPartition []rawCategory `json:"sub_partition"`
}

type rawCategoriesPage struct {
	CategoryData []rawCategory `json:"categoryData"`
}

type rawRoom struct {
	IDStr  string `json:"id_str"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Cover  struct {
		URLList []string `json:"url_list"`
	} `json:"cover"`
	Stats struct {
		TotalUserStr string `json:"total_user_str"`
		UserCountStr string `json:"user_count_str"`
	} `json:"stats"`
	Owner struct {
		Nickname string `json:"nickname"`
	} `json:"owner"`
	StreamURL struct {
		FlvPullURL        map[string]string `json:"flv_pull_url"`
		HlsPullURLMap     map[string]string `json:"hls_pull_url_map"`
		DefaultResolution string            `json:"default_resolution"`
	} `json:"stream_url"`
	RoomViewStats struct {
		DisplayValue int `json:"display_value"`
	} `json:"room_view_stats"`
}

type rawCategoryRoom struct {
	Room      rawRoom `json:"room"`
	TagName   string  `json:"tag_name"`
	WebRID    string  `json:"web_rid"`
	StreamSrc string  `json:"streamSrc"`
	Cover     string  `json:"cover"`
	Avatar    string  `json:"avatar"`
}

type rawCategoryPage struct {
	RoomsData struct {
		Count  int               `json:"count"`
		Offset int               `json:"offset"`
		Data   []rawCategoryRoom `json:"data"`
	} `json:"roomsData"`
	CategoryData []rawCategory `json:"categoryData"`
	CategoryList []string      `json:"categoryList"`
}

type categoryResult struct {
	Category categoryOutput
	Rooms    []roomOutput
	Error    error
}

// categoryTree separates leaf categories from overview partitions. Overview pages
// are the top-level partitions plus every grouping partition above the leaves;
// Douyin fills them with the strongest rooms across their children.
type categoryTree struct {
	Leaves       []categoryOutput
	Overviews    []categoryOutput
	LeafIDByName map[string]string
}

type httpStatusError struct {
	StatusCode int
	CategoryID string
}

func (err *httpStatusError) Error() string {
	return fmt.Sprintf("Douyin returned HTTP %d for category %s", err.StatusCode, err.CategoryID)
}

func main() {
	if len(os.Args) < 2 {
		fail("expected a command: categories, rooms, featured, or rooms-all")
	}

	timeout := 30 * time.Second
	switch os.Args[1] {
	case "rooms-all":
		timeout = 2 * time.Minute
	case "featured":
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	switch os.Args[1] {
	case "categories":
		getCategories(ctx)
	case "rooms":
		getRooms(ctx, os.Args[2:])
	case "featured":
		getFeaturedRooms(ctx, os.Args[2:])
	case "rooms-all":
		getAllRooms(ctx, os.Args[2:])
	default:
		fail("unknown command: " + os.Args[1])
	}
}

func getCategories(ctx context.Context) {
	categories, err := fetchLeafCategories(ctx)
	if err != nil {
		fail(err.Error())
	}

	writeJSON(categoriesResponse{Categories: categories})
}

func getRooms(ctx context.Context, args []string) {
	flags := flag.NewFlagSet("rooms", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	categoryID := flags.String("category", "", "Douyin category id")
	categoryName := flags.String("name", "直播", "Douyin category name")
	if err := flags.Parse(args); err != nil {
		fail(err.Error())
	}
	if strings.TrimSpace(*categoryID) == "" {
		fail("missing --category")
	}

	rooms, err := fetchRoomsByCategory(ctx, categoryOutput{ID: *categoryID, Name: *categoryName}, nil)
	if err != nil {
		fail(err.Error())
	}

	writeJSON(roomsResponse{Rooms: rooms})
}

// getFeaturedRooms reads every overview partition plus the requested hot leaf
// categories, so the quick refresh covers the strongest rooms of each partition.
func getFeaturedRooms(ctx context.Context, args []string) {
	flags := flag.NewFlagSet("featured", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	workers := flags.Int("workers", defaultWorkers, "Concurrent category requests")
	extra := flags.String("extra", "", "Comma-separated leaf category ids to include")
	if err := flags.Parse(args); err != nil {
		fail(err.Error())
	}
	if *workers < 1 || *workers > 16 {
		fail("workers must be between 1 and 16")
	}

	tree, err := fetchCategoryTree(ctx)
	if err != nil {
		fail(err.Error())
	}

	leavesByID := make(map[string]categoryOutput, len(tree.Leaves))
	for _, leaf := range tree.Leaves {
		leavesByID[leaf.ID] = leaf
	}
	extraLeaves := make([]categoryOutput, 0)
	for _, id := range strings.Split(*extra, ",") {
		if leaf, exists := leavesByID[strings.TrimSpace(id)]; exists {
			extraLeaves = append(extraLeaves, leaf)
		}
	}

	pages := uniqueCategories(tree.Overviews, extraLeaves)
	writeJSON(collectRooms(ctx, pages, *workers, tree.LeafIDByName, "douyin-featured-partitions"))
}

func getAllRooms(ctx context.Context, args []string) {
	flags := flag.NewFlagSet("rooms-all", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	workers := flags.Int("workers", defaultWorkers, "Concurrent category requests")
	if err := flags.Parse(args); err != nil {
		fail(err.Error())
	}
	if *workers < 1 || *workers > 16 {
		fail("workers must be between 1 and 16")
	}

	tree, err := fetchCategoryTree(ctx)
	if err != nil {
		fail(err.Error())
	}

	// Overview pages go first so their strongest rooms survive a timeout.
	pages := uniqueCategories(tree.Overviews, tree.Leaves)
	writeJSON(collectRooms(ctx, pages, *workers, tree.LeafIDByName, "douyin-category-aggregation"))
}

func collectRooms(
	ctx context.Context,
	categories []categoryOutput,
	workers int,
	leafIDByName map[string]string,
	source string,
) allRoomsResponse {
	results := make(chan categoryResult, workers)
	jobs := make(chan categoryOutput)
	var waitGroup sync.WaitGroup

	for i := 0; i < workers; i++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for category := range jobs {
				rooms, fetchErr := fetchRoomsByCategory(ctx, category, leafIDByName)
				result := categoryResult{Category: category, Rooms: rooms, Error: fetchErr}
				select {
				case results <- result:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for _, category := range categories {
			select {
			case jobs <- category:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		waitGroup.Wait()
		close(results)
	}()

	leafIDs := make(map[string]struct{}, len(leafIDByName))
	for _, leafID := range leafIDByName {
		leafIDs[leafID] = struct{}{}
	}
	roomsByID := make(map[string]roomOutput)
	failedCategories := make([]categoryFailure, 0)
	successfulCategories := 0
	for result := range results {
		if result.Error != nil {
			failedCategories = append(failedCategories, categoryFailure{
				ID:    result.Category.ID,
				Name:  result.Category.Name,
				Error: result.Error.Error(),
			})
			continue
		}
		successfulCategories++
		for _, room := range result.Rooms {
			current, exists := roomsByID[room.ID]
			if !exists {
				roomsByID[room.ID] = room
				continue
			}
			roomsByID[room.ID] = mergeRoomCopies(current, room, leafIDs)
		}
	}

	rooms := make([]roomOutput, 0, len(roomsByID))
	for _, room := range roomsByID {
		rooms = append(rooms, room)
	}
	sort.SliceStable(rooms, func(i, j int) bool {
		if rooms[i].Viewers == rooms[j].Viewers {
			return rooms[i].Title < rooms[j].Title
		}
		return rooms[i].Viewers > rooms[j].Viewers
	})

	partial := len(failedCategories) > 0 || ctx.Err() != nil
	return allRoomsResponse{
		Rooms:                rooms,
		CategoryCount:        len(categories),
		SuccessfulCategories: successfulCategories,
		FailedCategories:     failedCategories,
		Partial:              partial,
		Source:               source,
	}
}

// mergeRoomCopies keeps the freshest-looking audience value and the most specific
// category label when the same room appears on an overview page and a leaf page.
func mergeRoomCopies(current roomOutput, next roomOutput, leafIDs map[string]struct{}) roomOutput {
	merged := current
	if next.Viewers > current.Viewers {
		merged = next
	}
	_, currentIsLeaf := leafIDs[current.CategoryID]
	_, nextIsLeaf := leafIDs[next.CategoryID]
	if !currentIsLeaf && nextIsLeaf {
		merged.Category = next.Category
		merged.CategoryID = next.CategoryID
	} else if currentIsLeaf && !nextIsLeaf {
		merged.Category = current.Category
		merged.CategoryID = current.CategoryID
	}
	return merged
}

func fetchLeafCategories(ctx context.Context) ([]categoryOutput, error) {
	tree, err := fetchCategoryTree(ctx)
	if err != nil {
		return nil, err
	}
	return tree.Leaves, nil
}

func fetchCategoryTree(ctx context.Context) (categoryTree, error) {
	var page rawCategoriesPage
	if err := fetchPageDataWithRetry(ctx, categoryRootID, "categoryData", &page); err != nil {
		return categoryTree{}, err
	}

	tree := categoryTree{LeafIDByName: make(map[string]string)}
	collectCategories(page.CategoryData, nil, &tree)
	tree.Leaves = uniqueCategories(tree.Leaves)
	tree.Overviews = uniqueCategories(tree.Overviews)
	if len(tree.Leaves) == 0 {
		return categoryTree{}, errors.New("Douyin returned no live categories")
	}
	for _, leaf := range tree.Leaves {
		if _, exists := tree.LeafIDByName[leaf.Name]; !exists {
			tree.LeafIDByName[leaf.Name] = leaf.ID
		}
	}
	return tree, nil
}

func uniqueCategories(groups ...[]categoryOutput) []categoryOutput {
	seen := make(map[string]struct{})
	unique := make([]categoryOutput, 0)
	for _, group := range groups {
		for _, category := range group {
			if _, exists := seen[category.ID]; exists {
				continue
			}
			seen[category.ID] = struct{}{}
			unique = append(unique, category)
		}
	}
	return unique
}

func fetchRoomsByCategory(ctx context.Context, category categoryOutput, leafIDByName map[string]string) ([]roomOutput, error) {
	var page rawCategoryPage
	if err := fetchPageDataWithRetry(ctx, category.ID, "roomsData", &page); err != nil {
		return nil, err
	}

	rooms := make([]roomOutput, 0, len(page.RoomsData.Data))
	for _, raw := range page.RoomsData.Data {
		rooms = append(rooms, mapRoom(raw, category, leafIDByName))
	}
	return rooms, nil
}

func collectCategories(categories []rawCategory, parentIDs []string, tree *categoryTree) {
	for _, category := range categories {
		shortID := fmt.Sprintf("%d_%s", category.Partition.Type, category.Partition.IDStr)
		fullIDs := append(append([]string{}, parentIDs...), shortID)
		output := categoryOutput{ID: strings.Join(fullIDs, "_"), Name: category.Partition.Title}
		if len(parentIDs) == 0 || len(category.SubPartition) > 0 {
			tree.Overviews = append(tree.Overviews, output)
		}
		if len(category.SubPartition) == 0 {
			tree.Leaves = append(tree.Leaves, output)
			continue
		}
		collectCategories(category.SubPartition, fullIDs, tree)
	}
}

func mapRoom(raw rawCategoryRoom, category categoryOutput, leafIDByName map[string]string) roomOutput {
	viewerLabel := raw.Room.Stats.UserCountStr
	if raw.Room.RoomViewStats.DisplayValue > 0 {
		viewerLabel = strconv.Itoa(raw.Room.RoomViewStats.DisplayValue)
	}

	cover := raw.Cover
	if cover == "" && len(raw.Room.Cover.URLList) > 0 {
		cover = raw.Room.Cover.URLList[0]
	}

	roomID := raw.Room.IDStr
	if roomID == "" {
		roomID = raw.WebRID
	}

	// Overview pages mix rooms from many leaves; tag_name names the room's own leaf.
	categoryName := category.Name
	categoryID := category.ID
	if tagName := strings.TrimSpace(raw.TagName); tagName != "" && tagName != category.Name {
		categoryName = tagName
		if leafID, exists := leafIDByName[tagName]; exists {
			categoryID = leafID
		}
	}

	return roomOutput{
		ID:            roomID,
		DouyinID:      raw.WebRID,
		Title:         raw.Room.Title,
		Anchor:        raw.Room.Owner.Nickname,
		Category:      categoryName,
		CategoryID:    categoryID,
		Viewers:       parseViewerCount(viewerLabel),
		ViewerLabel:   viewerLabel,
		Cover:         cover,
		WebURL:        "https://live.douyin.com/" + raw.WebRID,
		Status:        "live",
		FlvStreamURLs: raw.Room.StreamURL.FlvPullURL,
		HlsStreamURLs: raw.Room.StreamURL.HlsPullURLMap,
	}
}

func fetchPageData(ctx context.Context, categoryID string, filter string, target any) error {
	if err := waitForRequest(ctx); err != nil {
		return err
	}
	requestURL := "https://live.douyin.com/categorynew/" + categoryID
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	request.Header.Set("Referer", "https://live.douyin.com/")
	request.Header.Set("Sec-Fetch-Site", "none")
	request.Header.Set("Sec-Fetch-Mode", "navigate")
	request.Header.Set("Sec-Fetch-User", "?1")
	request.Header.Set("Sec-Fetch-Dest", "document")
	request.Header.Set("Sec-CH-UA", `"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"`)
	request.Header.Set("Sec-CH-UA-Mobile", "?0")
	request.Header.Set("Sec-CH-UA-Platform", `"macOS"`)
	request.Header.Set("Upgrade-Insecure-Requests", "1")
	request.Header.Set("Cache-Control", "max-age=0")
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &httpStatusError{StatusCode: response.StatusCode, CategoryID: categoryID}
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, 24<<20))
	if err != nil {
		return err
	}
	parts := extractDataParts(string(body))
	selected := ""
	for _, part := range parts {
		if strings.Contains(part, filter) {
			selected = part
		}
	}
	if selected == "" {
		return fmt.Errorf("Douyin category %s did not contain %s", categoryID, filter)
	}
	return decodeFirstObject(selected, target)
}

func fetchPageDataWithRetry(ctx context.Context, categoryID string, filter string, target any) error {
	var fetchErr error
	for attempt := 0; attempt < 3; attempt++ {
		fetchErr = fetchPageData(ctx, categoryID, filter, target)
		if fetchErr == nil {
			return nil
		}
		if !isRetryable(fetchErr) || attempt == 2 {
			return fetchErr
		}
		if err := waitForRetry(ctx, time.Duration(attempt+1)*350*time.Millisecond); err != nil {
			return err
		}
	}
	return fetchErr
}

func waitForRequest(ctx context.Context) error {
	requestGate.Lock()
	now := time.Now()
	wait := time.Until(requestGate.next)
	if wait < 0 {
		wait = 0
	}
	requestGate.next = now.Add(wait + 80*time.Millisecond)
	requestGate.Unlock()

	if wait == 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func waitForRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func isRetryable(err error) bool {
	var statusErr *httpStatusError
	if !errors.As(err, &statusErr) {
		return true
	}
	return statusErr.StatusCode == http.StatusForbidden ||
		statusErr.StatusCode == http.StatusRequestTimeout ||
		statusErr.StatusCode == 425 ||
		statusErr.StatusCode == 429 ||
		statusErr.StatusCode == 444 ||
		statusErr.StatusCode >= 500
}

func extractDataParts(input string) []string {
	const functionName = "__pace_f"
	const endTag = "</script>"
	parts := make([]string, 0)
	for {
		start := strings.Index(input, functionName)
		if start == -1 {
			break
		}
		input = input[start+len(functionName):]
		quoteStart := strings.Index(input, `"`)
		if quoteStart < 0 {
			break
		}
		input = input[quoteStart+1:]
		scriptEnd := strings.Index(input, endTag)
		if scriptEnd < 0 {
			break
		}
		quoteEnd := strings.LastIndex(input[:scriptEnd], `"`)
		if quoteEnd < 0 {
			input = input[scriptEnd+len(endTag):]
			continue
		}
		var decoded string
		if err := json.Unmarshal([]byte(`"`+input[:quoteEnd]+`"`), &decoded); err == nil {
			parts = append(parts, decoded)
		}
		input = input[scriptEnd+len(endTag):]
	}

	joined := strings.Join(parts, "\n")
	output := make([]string, 0)
	for _, part := range strings.Split(joined, "\n") {
		start := strings.IndexAny(part, "[{")
		if start == -1 {
			continue
		}
		end := strings.LastIndexAny(part, "}]")
		if end == -1 || end < start {
			continue
		}
		output = append(output, part[start:end+1])
	}
	return output
}

func decodeFirstObject(input string, target any) error {
	var values []json.RawMessage
	if err := json.Unmarshal([]byte(input), &values); err != nil {
		return err
	}
	for _, value := range values {
		if len(value) == 0 || value[0] != '{' {
			continue
		}
		return json.Unmarshal(value, target)
	}
	return errors.New("Douyin payload did not contain an object")
}

func parseViewerCount(value string) int {
	clean := strings.TrimSpace(strings.ReplaceAll(value, ",", ""))
	if clean == "" {
		return 0
	}
	if count, err := strconv.Atoi(clean); err == nil {
		return count
	}

	for _, suffix := range []string{"万", "w", "W"} {
		if strings.HasSuffix(clean, suffix) {
			value := strings.TrimSuffix(clean, suffix)
			if count, err := strconv.ParseFloat(value, 64); err == nil {
				return int(count * 10000)
			}
		}
	}
	return 0
}

func statusLabel(status int) string {
	if status == 2 {
		return "live"
	}
	return "offline"
}

func writeJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
