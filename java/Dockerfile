# syntax=docker/dockerfile:1

# ---- 1. Build : Maven + JDK 25 (Alpine/musl), dépendances en cache, compilation, jlink ----
FROM maven:3.9-eclipse-temurin-25-alpine AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package \
 && mkdir -p /app && cp -r target/app.jar target/lib /app/
# JRE minimal : modules détectés par jdeps + ceux que Netty charge par réflexion.
RUN MODULES="$(jdeps --ignore-missing-deps --multi-release 25 --print-module-deps \
        --class-path '/app/lib/*' /app/app.jar /app/lib/*.jar 2>/dev/null | tail -n 1)" \
 && echo "jdeps: $MODULES" \
 && jlink --add-modules "$MODULES,jdk.unsupported,jdk.naming.dns,jdk.net" \
        --strip-debug --no-man-pages --no-header-files --compress=zip-6 \
        --output /jre

# ---- 2. Image finale : Alpine + JRE jlinké + cache AOT ----
FROM alpine:3.22
ENV JAVA_HOME=/jre PATH=/jre/bin:$PATH
COPY --from=build /jre /jre
COPY --from=build /app /app
COPY jvm.options /app/jvm.options
WORKDIR /app
# Exécution d'entraînement (JDK 25, JEP 483/514/515) : classes pré-chargées/liées et profils
# de méthodes enregistrés dans app.aot, réutilisés à chaque démarrage. Mêmes options JVM qu'en prod.
RUN AOT_TRAINING=1 PORT=18080 java @/app/jvm.options -XX:AOTCacheOutput=/app/app.aot -jar /app/app.jar
RUN adduser -D -H -u 10001 app
USER app
EXPOSE 8080
ENTRYPOINT ["java", "@/app/jvm.options", "-XX:AOTCache=/app/app.aot", "-jar", "/app/app.jar"]
