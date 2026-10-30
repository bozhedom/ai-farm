# Official Playwright image: Chromium and its system libraries at the exact package version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production
WORKDIR /agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
# The persistent browser profile lives in a volume mounted here; the browser user must own it.
RUN mkdir -p /agent/profile && chown -R pwuser:pwuser /agent/profile
# The image ships a non-root user for the browser; the agent never needs root.
USER pwuser
EXPOSE 8787
# A display lets the same normal Chromium renderer handle interactive login widgets.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "node", "--import", "tsx", "src/server.ts"]
