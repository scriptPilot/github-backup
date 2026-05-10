# Rules for AI Agents

## Backup algorithm changes

When modifying the backup logic in `index.js` in a way that changes the structure of the backup folder or the data stored per repository (e.g. new folders, renamed files, changed JSON shape), increment `METADATA_VERSION` at the top of `index.js`. This forces a full re-sync on the next run so all repositories are processed with the updated algorithm.

## README

Keep `README.md` in sync with the actual backup scope implemented in `index.js`. Whenever what is backed up changes (e.g. new data types, folder structure, included/excluded files), update `README.md` to reflect the current state.
