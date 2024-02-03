# Github Backup

Creates a local backup of your GitHub data.

## In Scope

- ✅ Repositories: cloned, public and private ones
- ✅ Releases: including images and assets
- ✅ Issues: including comments and images, open and closed ones
- ✅ User: details and starred repositories  

## In Progress
- ⏳ Readme: Images and file attachments
- ⏳ Releases: File attachments
- ⏳ Issues: File attachments
- ⏳ Projects: classic per repo and new projects per user

## Usage

Requirements: [Docker](https://www.docker.com/), [GitHub Token](https://github.com/settings/tokens)

1. Clone this repository
2. Update and save `.env.template` file as `.env`
3. Run `make` to start the backup process
