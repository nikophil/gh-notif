# Runs gh-notif without a desktop: notifications go through the browser tab
# (README « The web page »). `gh` reads GH_TOKEN, no `gh auth login` needed.
FROM node:22-alpine
RUN apk add --no-cache github-cli
WORKDIR /app
COPY gh-notif package.json ./
COPY src ./src
# Persisted state (prefs, hidden PRs, seen notifications) → volume.
ENV XDG_STATE_HOME=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7777
# Extra `gh notif` flags come from compose `command:` (appended here).
ENTRYPOINT ["node", "/app/gh-notif", "--no-open", "--port", "7777"]
