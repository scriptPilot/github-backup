# Github Backup

Creates a local backup of your GitHub data.

## Scope

- ✅ Own repositories: public and private, full clone
- ✅ Releases: source code, assets and attachments
- ✅ Issues: open and closed, comments and attachments
- ✅ Markdown files: attachments
- ✅ Starred repositories: shallow clone
- ✅ User profile: details and avatar

## Usage

Requirements: [Docker](https://www.docker.com/), [GitHub Token](https://github.com/settings/tokens)

1. Clone this repository
2. Update and save `.env.template` file as `.env`
3. Run `make` to start the backup process
