FROM oven/bun:1

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create workspace
WORKDIR /workspace
