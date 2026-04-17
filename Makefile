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

# Start the Docker Daemon
docker_start:
	open -a Docker && \
	while ! docker info > /dev/null 2>&1; do sleep 1; done