# Include the environment variables
include ./.env

# Run the Docker image and attach the environment file
docker_run: docker_build
	docker run --rm --name github-backup -v $(FOLDER):/usr/src/backup --env-file ./.env github-backup 

# Build the Docker image
docker_build: docker_cleanup
	docker build -t github-backup .

# Cleanup Docker
docker_cleanup:
	docker stop github-backup || true
	docker rm github-backup || true