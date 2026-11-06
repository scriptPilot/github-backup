# Include the environment variables
include ./.env

FOLDER_CLEAN := $(subst ",,$(FOLDER))

# Run the Docker image and attach the environment file
docker_run: docker_build
	docker run --rm --name github-backup --mount type=bind,src="$(FOLDER_CLEAN)",target=/usr/src/backup --env-file ./.env github-backup 

# Build the Docker image
docker_build: docker_cleanup
	docker build -t github-backup .

# Cleanup Docker
docker_cleanup: docker_start
	docker stop github-backup || true
	docker rm github-backup || true

# Start the Docker Daemon (Docker Desktop or OrbStack)
docker_start:
	@if open -a Docker 2>/dev/null; then \
		echo "Starting Docker Desktop..."; \
	elif open -a OrbStack 2>/dev/null; then \
		echo "Starting OrbStack..."; \
	else \
		echo "Unable to find Docker Desktop or OrbStack"; exit 1; \
	fi
	@while ! docker info > /dev/null 2>&1; do sleep 1; done