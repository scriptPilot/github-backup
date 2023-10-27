.PHONY: backup docker_cleanup

backup: docker_run

docker_run: docker_build
	docker run --rm --name github-backup github-backup

docker_build: docker_cleanup
	docker build -t github-backup .

docker_cleanup:
	docker stop github-backup || true
	docker rm github-backup || true