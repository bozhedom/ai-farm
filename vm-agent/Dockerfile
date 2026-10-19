# Official Playwright image: Chromium and its system libraries at the exact package version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production
WORKDIR /agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
# The image ships a non-root user for the browser; the agent never needs root.
USER pwuser
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
