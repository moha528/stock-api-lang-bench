// Routage HTTP et validation des entrées (fasthttp, routage manuel sans routeur
// tiers : 6 routes, un switch suffit et n'alloue rien).
package main

import (
	"bytes"
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"log"
	"math"
	"strconv"
	"sync"
	"unicode/utf8"

	"github.com/valyala/fasthttp"
)

var (
	contentTypeJSON = []byte("application/json")
	prefixProducts  = []byte("/products/")
	movements       = []byte("movements")

	bodyHealth            = []byte(`{"status":"ok"}`)
	bodyInvalidInput      = []byte(`{"error":"invalid_input"}`)
	bodyNotFound          = []byte(`{"error":"not_found"}`)
	bodyConflict          = []byte(`{"error":"conflict"}`)
	bodyInsufficientStock = []byte(`{"error":"insufficient_stock"}`)
	bodyInternal          = []byte(`{"error":"internal_error"}`)

	// Décodage strict (types exacts, UTF-8 valide), noms sensibles à la casse,
	// champs inconnus ignorés, doublons acceptés (dernier gagnant, comme JSON.parse).
	jsonOpts = jsontext.AllowDuplicateNames(true)

	bufPool = sync.Pool{New: func() any { b := make([]byte, 0, 16<<10); return &b }}
)

type router struct {
	store *Store
}

func newRouter(s *Store) *router { return &router{store: s} }

func (rt *router) handle(ctx *fasthttp.RequestCtx) {
	path := ctx.Path()
	switch string(path) {
	case "/health":
		if ctx.IsGet() {
			writeJSON(ctx, fasthttp.StatusOK, bodyHealth)
			return
		}
	case "/products":
		if ctx.IsGet() {
			rt.listProducts(ctx)
			return
		}
		if ctx.IsPost() {
			rt.createProduct(ctx)
			return
		}
	case "/stats":
		if ctx.IsGet() {
			rt.stats(ctx)
			return
		}
	default:
		if rest, ok := bytes.CutPrefix(path, prefixProducts); ok {
			idPart, tail, hasTail := bytes.Cut(rest, []byte{'/'})
			if !hasTail {
				if ctx.IsGet() {
					rt.getProduct(ctx, idPart)
					return
				}
			} else if bytes.Equal(tail, movements) {
				if ctx.IsPost() {
					rt.addMovement(ctx, idPart)
					return
				}
			}
		}
	}
	writeJSON(ctx, fasthttp.StatusNotFound, bodyNotFound)
}

func (rt *router) listProducts(ctx *fasthttp.RequestCtx) {
	args := ctx.QueryArgs()
	limit, offset := int64(50), int64(0)
	if args.Has("limit") {
		v, ok := parseUint(args.Peek("limit"))
		if !ok || v < 1 || v > 100 {
			writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
			return
		}
		limit = v
	}
	if args.Has("offset") {
		v, ok := parseUint(args.Peek("offset"))
		if !ok {
			writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
			return
		}
		offset = v
	}
	bp := bufPool.Get().(*[]byte)
	buf, err := rt.store.ListProducts(context.Background(), (*bp)[:0], limit, offset)
	rt.respond(ctx, fasthttp.StatusOK, buf, err)
	*bp = buf
	bufPool.Put(bp)
}

func (rt *router) getProduct(ctx *fasthttp.RequestCtx, idPart []byte) {
	id, ok := parseID(idPart)
	if !ok {
		writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
		return
	}
	bp := bufPool.Get().(*[]byte)
	buf, err := rt.store.GetProduct(context.Background(), (*bp)[:0], id)
	rt.respond(ctx, fasthttp.StatusOK, buf, err)
	*bp = buf
	bufPool.Put(bp)
}

type createProductReq struct {
	SKU        *string `json:"sku"`
	Name       *string `json:"name"`
	Quantity   *int64  `json:"quantity"`
	PriceCents *int64  `json:"price_cents"`
}

func (rt *router) createProduct(ctx *fasthttp.RequestCtx) {
	var req createProductReq
	if err := json.Unmarshal(ctx.PostBody(), &req, jsonOpts); err != nil ||
		!validString(req.SKU, 64) || !validString(req.Name, 200) ||
		req.Quantity == nil || *req.Quantity < 0 || *req.Quantity > math.MaxInt32 ||
		req.PriceCents == nil || *req.PriceCents < 0 {
		writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
		return
	}
	bp := bufPool.Get().(*[]byte)
	buf, err := rt.store.CreateProduct(context.Background(), (*bp)[:0], *req.SKU, *req.Name, int32(*req.Quantity), *req.PriceCents)
	rt.respond(ctx, fasthttp.StatusCreated, buf, err)
	*bp = buf
	bufPool.Put(bp)
}

type movementReq struct {
	Delta  *int64  `json:"delta"`
	Reason *string `json:"reason"`
}

func (rt *router) addMovement(ctx *fasthttp.RequestCtx, idPart []byte) {
	id, ok := parseID(idPart)
	if !ok {
		writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
		return
	}
	var req movementReq
	if err := json.Unmarshal(ctx.PostBody(), &req, jsonOpts); err != nil ||
		req.Delta == nil || *req.Delta == 0 || *req.Delta < -1_000_000 || *req.Delta > 1_000_000 ||
		!validString(req.Reason, 100) {
		writeJSON(ctx, fasthttp.StatusBadRequest, bodyInvalidInput)
		return
	}
	qty, movementID, err := rt.store.AddMovement(context.Background(), id, int32(*req.Delta), *req.Reason)
	if err != nil {
		rt.respond(ctx, 0, nil, err)
		return
	}
	var arr [96]byte
	buf := append(arr[:0], `{"product_id":`...)
	buf = strconv.AppendInt(buf, id, 10)
	buf = append(buf, `,"quantity":`...)
	buf = strconv.AppendInt(buf, int64(qty), 10)
	buf = append(buf, `,"movement_id":`...)
	buf = strconv.AppendInt(buf, movementID, 10)
	buf = append(buf, '}')
	writeJSON(ctx, fasthttp.StatusOK, buf)
}

func (rt *router) stats(ctx *fasthttp.RequestCtx) {
	products, totalQty, totalValue, err := rt.store.Stats(context.Background())
	if err != nil {
		rt.respond(ctx, 0, nil, err)
		return
	}
	var arr [128]byte
	buf := append(arr[:0], `{"products":`...)
	buf = strconv.AppendInt(buf, products, 10)
	buf = append(buf, `,"total_quantity":`...)
	buf = strconv.AppendInt(buf, totalQty, 10)
	buf = append(buf, `,"total_value_cents":`...)
	buf = strconv.AppendInt(buf, totalValue, 10)
	buf = append(buf, '}')
	writeJSON(ctx, fasthttp.StatusOK, buf)
}

// respond écrit body avec status si err est nil, sinon l'erreur métier associée.
func (rt *router) respond(ctx *fasthttp.RequestCtx, status int, body []byte, err error) {
	switch {
	case err == nil:
		writeJSON(ctx, status, body)
	case errors.Is(err, ErrNotFound):
		writeJSON(ctx, fasthttp.StatusNotFound, bodyNotFound)
	case errors.Is(err, ErrConflict):
		writeJSON(ctx, fasthttp.StatusConflict, bodyConflict)
	case errors.Is(err, ErrInsufficientStock):
		writeJSON(ctx, fasthttp.StatusConflict, bodyInsufficientStock)
	default:
		log.Printf("erreur base: %v", err)
		writeJSON(ctx, fasthttp.StatusInternalServerError, bodyInternal)
	}
}

// writeJSON copie body dans le tampon (mutualisé) de la réponse fasthttp.
func writeJSON(ctx *fasthttp.RequestCtx, status int, body []byte) {
	ctx.SetStatusCode(status)
	ctx.Response.Header.SetContentTypeBytes(contentTypeJSON)
	ctx.SetBody(body)
}

func validString(s *string, max int) bool {
	if s == nil || len(*s) == 0 {
		return false
	}
	return utf8.RuneCountInString(*s) <= max
}

// parseUint accepte uniquement des chiffres décimaux (pas de signe, pas
// d'espace) tenant dans un int64.
func parseUint(b []byte) (int64, bool) {
	if len(b) == 0 || len(b) > 19 {
		return 0, false
	}
	var n int64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		d := int64(c - '0')
		if n > (math.MaxInt64-d)/10 {
			return 0, false
		}
		n = n*10 + d
	}
	return n, true
}

// parseID : entier int64 strictement positif.
func parseID(b []byte) (int64, bool) {
	n, ok := parseUint(b)
	return n, ok && n > 0
}
