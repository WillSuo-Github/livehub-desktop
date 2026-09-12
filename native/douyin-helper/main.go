package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/caiguanhao/dylive"
)

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
	Viewers       int               `json:"viewers"`
	ViewerLabel   string            `json:"viewerLabel"`
	Cover         string            `json:"cover"`
	WebURL        string            `json:"webUrl"`
	Status        string            `json:"status"`
	FlvStreamURLs map[string]string `json:"flvStreamUrls"`
	HlsStreamURLs map[string]string `json:"hlsStreamUrls"`
}

type categoriesResponse struct {
	Categories []categoryOutput `json:"categories"`
}

type roomsResponse struct {
	Rooms []roomOutput `json:"rooms"`
}

func main() {
	if len(os.Args) < 2 {
		fail("expected a command: categories or rooms")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	switch os.Args[1] {
	case "categories":
		getCategories(ctx)
	case "rooms":
		getRooms(ctx, os.Args[2:])
	default:
		fail("unknown command: " + os.Args[1])
	}
}

func getCategories(ctx context.Context) {
	categories, err := dylive.GetCategories(ctx)
	if err != nil {
		fail(err.Error())
	}

	output := categoriesResponse{}
	flattenLeafCategories(categories, &output.Categories)
	writeJSON(output)
}

func getRooms(ctx context.Context, args []string) {
	flags := flag.NewFlagSet("rooms", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	categoryID := flags.String("category", "", "Douyin category id")
	if err := flags.Parse(args); err != nil {
		fail(err.Error())
	}
	if strings.TrimSpace(*categoryID) == "" {
		fail("missing --category")
	}

	rooms, err := dylive.GetRoomsByCategory(ctx, *categoryID)
	if err != nil {
		fail(err.Error())
	}

	output := roomsResponse{Rooms: make([]roomOutput, 0, len(rooms))}
	for _, room := range rooms {
		output.Rooms = append(output.Rooms, mapRoom(room))
	}
	writeJSON(output)
}

func flattenLeafCategories(categories []dylive.Category, output *[]categoryOutput) {
	for _, category := range categories {
		if len(category.Categories) == 0 {
			*output = append(*output, categoryOutput{ID: category.Id, Name: category.Name})
			continue
		}
		flattenLeafCategories(category.Categories, output)
	}
}

func mapRoom(room dylive.Room) roomOutput {
	categoryName := "直播"
	if room.Category != nil && room.Category.Name != "" {
		categoryName = room.Category.Name
	}

	return roomOutput{
		ID:            room.Id,
		DouyinID:      room.DouyinId,
		Title:         room.Name,
		Anchor:        room.User.Name,
		Category:      categoryName,
		Viewers:       parseViewerCount(room.CurrentUsersCount),
		ViewerLabel:   room.CurrentUsersCount,
		Cover:         room.CoverUrl,
		WebURL:        room.WebUrl,
		Status:        statusLabel(room.StatusCode),
		FlvStreamURLs: room.FlvStreamUrls,
		HlsStreamURLs: room.HlsStreamUrls,
	}
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

func statusLabel(status dylive.RoomStatus) string {
	if status == dylive.RoomStatusLiveOn {
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
