FROM node:24-bookworm-slim AS editor
WORKDIR /build
COPY frontend/editor/package*.json frontend/editor/
RUN npm ci --prefix frontend/editor
COPY frontend/admin/package*.json frontend/admin/
RUN npm ci --prefix frontend/admin
COPY frontend/editor frontend/editor
COPY frontend/admin frontend/admin
COPY src/Blog.Web/Domain/ContentLimits.cs src/Blog.Web/Domain/ContentLimits.cs
RUN npm run build --prefix frontend/editor
RUN npm run build --prefix frontend/admin

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS build
WORKDIR /build
COPY Directory.Build.props global.json ./
COPY src/Blog.Web/Blog.Web.csproj src/Blog.Web/
COPY src/Blog.Web/packages.lock.json src/Blog.Web/
RUN dotnet restore src/Blog.Web --locked-mode
COPY src src
COPY dist dist
COPY data data
COPY --from=editor /build/src/Blog.Web/wwwroot/js/admin/editor.bundle.js src/Blog.Web/wwwroot/js/admin/
COPY --from=editor /build/src/Blog.Web/wwwroot/vendor/tabler src/Blog.Web/wwwroot/vendor/tabler
RUN dotnet publish src/Blog.Web -c Release --no-restore -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg clamav clamav-freshclam curl && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /var/lib/clamav && chown -R app:app /data /var/lib/clamav
WORKDIR /app
COPY --from=build /out .
COPY eng/container-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENV ASPNETCORE_HTTP_PORTS=8080 Blog__StoragePath=/data Media__FfmpegPath=/usr/bin/ffmpeg Media__FfprobePath=/usr/bin/ffprobe Media__ScannerPath=/usr/bin/clamscan Media__ScannerDatabasePath=/var/lib/clamav
USER app
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
