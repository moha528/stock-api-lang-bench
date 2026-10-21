// Accès aux données : les requêtes SQL de SPEC.md, exécutées en requêtes
// préparées (cache de statements pgx, protocole binaire).
//
// Les lectures de produits sont sérialisées directement depuis les octets bruts
// renvoyés par Postgres (RawValues) vers le tampon JSON de la réponse : aucune
// struct intermédiaire, aucune allocation de chaîne par ligne.
package main

import (
	"context"
	"encoding/binary"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sqlListProducts  = `SELECT id, sku, name, quantity, price_cents FROM products ORDER BY id LIMIT $1 OFFSET $2`
	sqlGetProduct    = `SELECT id, sku, name, quantity, price_cents FROM products WHERE id = $1`
	sqlInsertProduct = `INSERT INTO products (sku, name, quantity, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO NOTHING RETURNING id, sku, name, quantity, price_cents`
	sqlMovement      = `WITH upd AS (
  UPDATE products SET quantity = quantity + $2, updated_at = now()
  WHERE id = $1 AND quantity + $2 >= 0
  RETURNING id, quantity
), ins AS (
  INSERT INTO stock_movements (product_id, delta, reason)
  SELECT id, $2, $3 FROM upd
  RETURNING id
)
SELECT upd.quantity, ins.id FROM upd, ins`
	sqlProductExists = `SELECT 1 FROM products WHERE id = $1`
	sqlStats         = `SELECT count(*)::bigint, coalesce(sum(quantity), 0)::bigint, coalesce(sum(quantity::bigint * price_cents), 0)::bigint FROM products`
)

var (
	ErrNotFound          = errors.New("not_found")
	ErrConflict          = errors.New("conflict")
	ErrInsufficientStock = errors.New("insufficient_stock")
)

// Store regroupe l'accès Postgres. Le contexte fourni est indépendant de la
// requête HTTP pour qu'un arrêt du serveur n'annule pas les requêtes en vol.
type Store struct {
	pool *pgxpool.Pool
}

// ListProducts ajoute à buf le tableau JSON des produits de la page demandée.
func (s *Store) ListProducts(ctx context.Context, buf []byte, limit, offset int64) ([]byte, error) {
	rows, err := s.pool.Query(ctx, sqlListProducts, limit, offset)
	if err != nil {
		return buf, err
	}
	defer rows.Close()
	buf = append(buf, '[')
	first := true
	for rows.Next() {
		if !first {
			buf = append(buf, ',')
		}
		first = false
		buf = appendProductRow(buf, rows.FieldDescriptions(), rows.RawValues())
	}
	if err := rows.Err(); err != nil {
		return buf, err
	}
	return append(buf, ']'), nil
}

// GetProduct ajoute à buf l'objet JSON du produit, ou renvoie ErrNotFound.
func (s *Store) GetProduct(ctx context.Context, buf []byte, id int64) ([]byte, error) {
	return s.oneProduct(ctx, buf, ErrNotFound, sqlGetProduct, id)
}

// CreateProduct ajoute à buf l'objet JSON du produit créé, ou renvoie ErrConflict.
func (s *Store) CreateProduct(ctx context.Context, buf []byte, sku, name string, quantity int32, priceCents int64) ([]byte, error) {
	return s.oneProduct(ctx, buf, ErrConflict, sqlInsertProduct, sku, name, quantity, priceCents)
}

func (s *Store) oneProduct(ctx context.Context, buf []byte, noRow error, sql string, args ...any) ([]byte, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return buf, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return buf, err
		}
		return buf, noRow
	}
	buf = appendProductRow(buf, rows.FieldDescriptions(), rows.RawValues())
	rows.Close()
	return buf, rows.Err()
}

// AddMovement applique un mouvement de stock atomique.
func (s *Store) AddMovement(ctx context.Context, id int64, delta int32, reason string) (quantity int32, movementID int64, err error) {
	err = s.pool.QueryRow(ctx, sqlMovement, id, delta, reason).Scan(&quantity, &movementID)
	if err == nil {
		return quantity, movementID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, err
	}
	var one int32
	err = s.pool.QueryRow(ctx, sqlProductExists, id).Scan(&one)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return 0, 0, ErrNotFound
	case err != nil:
		return 0, 0, err
	default:
		return 0, 0, ErrInsufficientStock
	}
}

// Stats renvoie le nombre de produits, la quantité totale et la valeur totale.
func (s *Store) Stats(ctx context.Context) (products, totalQuantity, totalValueCents int64, err error) {
	err = s.pool.QueryRow(ctx, sqlStats).Scan(&products, &totalQuantity, &totalValueCents)
	return
}

// appendProductRow sérialise une ligne (id, sku, name, quantity, price_cents).
func appendProductRow(buf []byte, fds []pgconn.FieldDescription, vals [][]byte) []byte {
	buf = append(buf, `{"id":`...)
	buf = appendRawInt(buf, fds[0].Format, vals[0])
	buf = append(buf, `,"sku":`...)
	buf = appendJSONString(buf, vals[1])
	buf = append(buf, `,"name":`...)
	buf = appendJSONString(buf, vals[2])
	buf = append(buf, `,"quantity":`...)
	buf = appendRawInt(buf, fds[3].Format, vals[3])
	buf = append(buf, `,"price_cents":`...)
	buf = appendRawInt(buf, fds[4].Format, vals[4])
	return append(buf, '}')
}

// appendRawInt écrit un int2/int4/int8 Postgres : big-endian en binaire,
// décimal ASCII (déjà un nombre JSON valide) en texte.
func appendRawInt(buf []byte, format int16, v []byte) []byte {
	if format != pgx.BinaryFormatCode {
		return append(buf, v...)
	}
	switch len(v) {
	case 8:
		return strconv.AppendInt(buf, int64(binary.BigEndian.Uint64(v)), 10)
	case 4:
		return strconv.AppendInt(buf, int64(int32(binary.BigEndian.Uint32(v))), 10)
	case 2:
		return strconv.AppendInt(buf, int64(int16(binary.BigEndian.Uint16(v))), 10)
	}
	return append(buf, '0')
}

const hexDigits = "0123456789abcdef"

// appendJSONString écrit une chaîne JSON avec le même échappement que
// JSON.stringify : seuls '"', '\\' et les caractères de contrôle sont échappés
// (pas d'échappement HTML de <, >, & comme le fait encoding/json).
func appendJSONString(buf []byte, s []byte) []byte {
	buf = append(buf, '"')
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		buf = append(buf, s[start:i]...)
		switch c {
		case '"':
			buf = append(buf, '\\', '"')
		case '\\':
			buf = append(buf, '\\', '\\')
		case '\n':
			buf = append(buf, '\\', 'n')
		case '\r':
			buf = append(buf, '\\', 'r')
		case '\t':
			buf = append(buf, '\\', 't')
		case '\b':
			buf = append(buf, '\\', 'b')
		case '\f':
			buf = append(buf, '\\', 'f')
		default:
			buf = append(buf, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		}
		start = i + 1
	}
	buf = append(buf, s[start:]...)
	return append(buf, '"')
}
