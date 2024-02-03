# Github Backup

Creates a local backup of your GitHub data.

## In Scope

- ✅ Repositories: cloned, public and private ones
- ✅ Releases: including images and assets
- ✅ Issues: including comments and images, open and closed ones
- ✅ Markdown: images, uploaded to the GitHub editor
- ✅ User: user details and starred repositories  

## Usage

Requirements: [Docker](https://www.docker.com/), [GitHub Token](https://github.com/settings/tokens)

1. Clone this repository
2. Update and save `.env.template` file as `.env`
3. Run `make` to start the backup process
