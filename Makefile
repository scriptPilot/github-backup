include ./.env

docker_run: docker_build
	docker run --rm --name github-backup -v $(FOLDER):/usr/src/backup --env-file ./.env github-backup 

docker_build: docker_cleanup
	docker build -t github-backup .

docker_cleanup:
	docker stop github-backup || true
	docker rm github-backup || true