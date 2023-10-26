.PHONY: backup

backup: install
	node index.js

install:
	npm install

