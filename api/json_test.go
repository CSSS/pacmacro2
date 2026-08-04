package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newJSONRequest(t *testing.T, method, target string, body any) *http.Request {
	t.Helper()

	JSON, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal JSON request: %v", err)
	}

	request := httptest.NewRequest(method, target, bytes.NewReader(JSON))
	request.Header.Set("Content-Type", "application/json")
	return request
}
