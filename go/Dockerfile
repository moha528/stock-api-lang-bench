# syntax=docker/dockerfile:1
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/stock-api .

FROM scratch
COPY --from=build /out/stock-api /stock-api
# GOMAXPROCS suit automatiquement le quota cgroup (1 vCPU) depuis Go 1.25.
# Limite mémoire douce sous les 512 Mo du conteneur ; GOGC relevé pour espacer
# les cycles de GC (le tas vivant est minuscule), GOMEMLIMIT reprend la main près du plafond.
ENV GOMEMLIMIT=400MiB \
    GOGC=200
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/stock-api"]
