# syntax=docker/dockerfile:1

# ---- build : glibc (Debian 13), même version de libc que l'image finale ----
FROM rust:1.99-slim-trixie AS build
WORKDIR /app

# 1) Dépendances seules, avec un main factice : cette couche reste en cache tant que
#    Cargo.toml / Cargo.lock ne changent pas.
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/stock-api* target/release/deps/stock_api* target/release/.fingerprint/stock-api-*

# 2) Code de l'application.
COPY src ./src
RUN cargo build --release --locked

# ---- runtime : distroless cc (glibc + libgcc, sans shell ni gestionnaire de paquets) ----
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=build /app/target/release/stock-api /stock-api
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/stock-api"]
