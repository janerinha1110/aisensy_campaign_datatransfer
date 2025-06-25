#!/bin/bash

# Render build script for AISensy Campaign Scraper
echo "Starting build process..."

# Install dependencies
npm install

# Install Playwright browsers only if we're not in a headless environment
if [ -z "$RENDER" ]; then
    echo "Installing Playwright browsers..."
    npx playwright install chromium --with-deps
else
    echo "Skipping browser installation on Render (will use system browsers)"
fi

echo "Build completed successfully!" 