package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func sampleRoom(id string, viewers int) rawCategoryRoom {
	var room rawCategoryRoom
	room.WebRID = id
	room.Room.IDStr = id
	room.Room.Owner.Nickname = "Anchor " + id
	room.Room.RoomViewStats.DisplayValue = viewers
	return room
}

func samplePage(start, count, offset int) directoryPage {
	page := directoryPage{Count: count, Offset: offset, Rooms: []rawCategoryRoom{}}
	for i := start; i < start+count; i++ {
		page.Rooms = append(page.Rooms, sampleRoom(fmt.Sprint(i), i))
	}
	return page
}

func TestDirectoryPaginatesFairlyAndMergesDuplicates(t *testing.T) {
	var calls []string
	result := collectDirectory(context.Background(), []categoryOutput{{"4_103", "Games"}, {"4_103_1_7", "Leaf"}}, 1,
		map[string]string{"Leaf": "4_103_1_7"}, "douyin-category-aggregation",
		func(_ context.Context, category categoryOutput, offset int) (directoryPage, error) {
			calls = append(calls, fmt.Sprintf("%s:%d", category.ID, offset))
			if category.ID == "4_103_1_7" {
				return directoryPage{[]rawCategoryRoom{sampleRoom("1", 999)}, 1, 1}, nil
			}
			if offset == 0 {
				return samplePage(1, 15, 15), nil
			}
			return samplePage(15, 2, 17), nil
		})
	if !reflect.DeepEqual(calls, []string{"4_103:0", "4_103_1_7:0", "4_103:15"}) {
		t.Fatalf("cursor order: %v", calls)
	}
	if len(result.Rooms) != 16 || result.Rooms[0].Viewers != 999 || result.Rooms[0].Category != "Leaf" {
		t.Fatalf("merge failed: %+v", result)
	}
	if result.Partial || result.SuccessfulCategories != 2 || result.PagesFetched != 3 {
		t.Fatalf("coverage: %+v", result)
	}
	if result.Complete || !strings.Contains(result.CoverageNote, "不代表抖音全站") {
		t.Fatal("a curated category index must not claim global completeness")
	}
}

func TestDirectoryKeepsEarlierPagesOnFailure(t *testing.T) {
	result := collectDirectory(context.Background(), []categoryOutput{{"4_103", "Games"}}, 1, nil, "douyin-category-aggregation",
		func(_ context.Context, _ categoryOutput, offset int) (directoryPage, error) {
			if offset == 0 {
				return samplePage(1, 15, 15), nil
			}
			return directoryPage{}, fmt.Errorf("blocked")
		})
	if len(result.Rooms) != 15 || !result.Partial || len(result.FailedCategories) != 1 || result.SuccessfulCategories != 0 {
		t.Fatalf("lost partial results: %+v", result)
	}
}

func TestDirectoryRejectsStalledOrRepeatedPages(t *testing.T) {
	for _, name := range []string{"cursor", "duplicates"} {
		t.Run(name, func(t *testing.T) {
			result := collectDirectory(context.Background(), []categoryOutput{{"4_103", "Games"}}, 1, nil, "douyin-category-aggregation",
				func(_ context.Context, _ categoryOutput, offset int) (directoryPage, error) {
					if name == "cursor" {
						return samplePage(1, 15, offset), nil
					}
					return samplePage(1, 15, offset+15), nil
				})
			if !result.Partial || !strings.Contains(result.FailedCategories[0].Error, "stalled") || len(result.Rooms) != 15 {
				t.Fatalf("false completeness: %+v", result)
			}
		})
	}
}

func TestDirectoryCancellationIncludesUnstartedCategories(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := collectDirectory(ctx, []categoryOutput{{"4_101", "Chat"}, {"4_102", "Music"}}, 1, nil, "douyin-category-aggregation",
		func(context.Context, categoryOutput, int) (directoryPage, error) {
			t.Fatal("canceled work started")
			return directoryPage{}, nil
		})
	if !result.Partial || len(result.FailedCategories) != 2 || result.SuccessfulCategories != 0 {
		t.Fatalf("cancellation hidden: %+v", result)
	}
}

func TestFeaturedNeverWalksPastFirstPage(t *testing.T) {
	calls := 0
	result := collectDirectory(context.Background(), []categoryOutput{{"4_103", "Games"}}, 1, nil, "douyin-featured-partitions",
		func(context.Context, categoryOutput, int) (directoryPage, error) {
			calls++
			return samplePage(1, 15, 15), nil
		})
	if calls != 1 || result.Complete || result.Partial || !strings.Contains(result.CoverageNote, "采样") {
		t.Fatalf("featured coverage: %+v", result)
	}
}

func TestDirectoryAPIValidatesResponseAndForwardsCursor(t *testing.T) {
	for _, body := range []string{
		`{"status_code":0,"data":{"count":0,"offset":30,"data":[]}}`,
		``, `{"status_code":0}`, `{"status_code":1,"data":{"count":0,"offset":30,"data":[]}}`,
		`{"status_code":0,"data":{"count":0,"data":[]}}`,
		`{"status_code":0,"data":{"count":15,"offset":30,"data":[]}}`,
	} {
		t.Run(fmt.Sprintf("body_%d", len(body)), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("offset") != "15" || r.URL.Query().Get("category") != "4_103_1_7" {
					t.Errorf("wrong request: %s", r.URL)
				}
				fmt.Fprint(w, body)
			}))
			defer server.Close()
			t.Setenv("LIVEHUB_DOUYIN_PAGING_URL", server.URL)
			page, err := fetchDirectoryAPI(context.Background(), categoryOutput{"4_103_1_7", "Leaf"}, 15)
			valid := strings.Contains(body, `"count":0,"offset":30`) && strings.Contains(body, `"status_code":0`)
			if valid && (err != nil || page.Offset != 30) {
				t.Fatalf("valid empty final page rejected: %v", err)
			}
			if !valid && err == nil {
				t.Fatal("invalid/blocked response treated as exhaustion")
			}
		})
	}
}

func TestAPIGameTagMapsToLeaf(t *testing.T) {
	var raw rawCategoryRoom
	if err := json.Unmarshal([]byte(`{"room":{"id_str":"1","owner":{"nickname":"Anchor"}},"web_rid":"2","game_tag":"Delta"}`), &raw); err != nil {
		t.Fatal(err)
	}
	room := mapRoom(raw, categoryOutput{"4_103", "Games"}, map[string]string{"Delta": "4_103_1_7"})
	if room.CategoryID != "4_103_1_7" || room.Category != "Delta" {
		t.Fatalf("lost API game tag: %+v", room)
	}
}
