import fs from 'fs-extra'
import shell from 'shelljs'
import { relative, dirname, basename, extname } from 'path'
import fetch from 'node-fetch'
import { extension } from 'mime-types'
import { glob } from 'glob'

shell.config.fatal = true

const perPage = 100
const retryCount = 10
const retryDelayRateLimit = 6 * 60
const retryDelayOthers = 6

const { USERNAME, TOKEN } = process.env
const folder = '/usr/src/backup'
const metadataPath = `${folder}/metadata.json`
const METADATA_VERSION = 3

function delay(seconds) {
  return new Promise(resolve => {
    console.log(`... delay ${seconds}s`)
    setTimeout(() => {
      return resolve()
    }, seconds * 1000)
  })
}

function request(path, options = {}) {
  return new Promise(async (resolve, reject) => {
    const baseUrl = path.substr(0, 4) !== 'http' ? 'https://api.github.com' : ''
    console.log(`Request ${baseUrl}${path}`)
    for (let n = 1; n <= retryCount; n++) {
      let resp
      try {
        resp = await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: {
            Authorization: `Token ${TOKEN}`,
            ...options.headers || {}
          }
        })
      } catch {
        console.log(`... failed at #${n} attempt`)
        if (n < retryCount) {
          await delay(retryDelayOthers)
          continue
        } else {
          return reject()          
        }
      }
      if (resp.ok) {
        return resolve(resp)
      } else {
        const rateLimitHeader = [ ...resp.headers ].find(obj => obj[0] === 'x-ratelimit-remaining')
        const rateLimitLimitHeader = [ ...resp.headers ].find(obj => obj[0] === 'x-ratelimit-limit')
        const rateLimitRemaining = rateLimitHeader ? parseInt(rateLimitHeader[1]) : null
        const rateLimitLimit = rateLimitLimitHeader ? parseInt(rateLimitLimitHeader[1]) : null
        console.log(`... failed at #${n} attempt (status ${resp.status})`)
        if (rateLimitRemaining === 0) {
          console.log(`... API rate limit of ${rateLimitLimit} requests per hour exceeded`)
          if (n < retryCount) await delay(retryDelayRateLimit)
        } else {
          if (n < retryCount) await delay(retryDelayOthers)
        }
      }
    }
    return reject()
  })
}

function requestJson(path, options) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await request(path, options) 
      const json = await response.json()
      return resolve(json)
    } catch (err) {
      return reject(err)
    }
  })
}

function requestAll(path, options) {
  return new Promise(async (resolve, reject) => {
    try {
      let items = []
      let page = 1
      while (page !== null) {          
        const separator = path.indexOf('?') === -1 ? '?' : '&'
        const moreItemsResponse = await request(`${path}${separator}per_page=${perPage}&page=${page}`, options) 
        const moreItems = await moreItemsResponse.json()
        if (moreItems.length) {
          items = [...items, ...moreItems]
          page = moreItems.length === perPage ? page + 1 : null
        } else {
          page = null
        }
      }
      return resolve(items)
    } catch (err) {
      return reject(err)
    }
  })
}

async function requestAllWithRetry(path, options) {
  for (let n = 1; n <= retryCount; n++) {
    try  {
      const items = requestAll(path, options)
      return items
    } catch (err) {
      if (n === 10) return err
      console.log('... failed at attempt #' + n)
      await delay(retryDelayOthers)
    } 
  }
}

function downloadFile(sourceFileUrl, targetFilePath) {
  return new Promise(async (resolve, reject) => {
    // Prefer the extension from the source URL (e.g. .zip, .pdf in /files/<id>/<name>.zip)
    if (!extname(targetFilePath)) {
      let urlExt = ''
      try { urlExt = extname(new URL(sourceFileUrl).pathname) } catch {}
      if (urlExt) targetFilePath = targetFilePath + urlExt
    }
    // Skip download if file already exists (check with any extension if none specified)
    if (!extname(targetFilePath)) {
      const dir = dirname(targetFilePath)
      const base = basename(targetFilePath)
      if (fs.existsSync(dir)) {
        const existing = fs.readdirSync(dir).filter(f => f.startsWith(base + '.'))
        if (existing.length > 0) {
          return resolve(`${dir}/${existing[0]}`)
        }
      }
    } else if (fs.existsSync(targetFilePath)) {
      return resolve(targetFilePath)
    }
    const isArchive = /\/(zipball|tarball)\//.test(sourceFileUrl)
    const requestOptions = isArchive ? {} : { headers: { Accept: 'application/octet-stream' } }
    const response = await request(sourceFileUrl, requestOptions)
    if (!extname(targetFilePath)) {
      const ctHeader = [ ...response.headers ].find(obj => obj[0] === 'content-type')
      const ext = ctHeader ? extension(ctHeader[1]) : ''
      targetFilePath = targetFilePath + (ext ? '.' + ext : '.bin')
    }
    fs.ensureDirSync(dirname(targetFilePath))
    const fileStream = fs.createWriteStream(targetFilePath)
    response.body.pipe(fileStream)
    response.body.on('error', () => { return reject() })
    fileStream.on('finish', () => {
      return resolve(targetFilePath)
    })
  })
}

function downloadAttachments(body, folder, filename, baseAttachmentPath = './attachments') {
  return new Promise(async (resolve, reject) => {
    try {
      const files = []
      const attachments = body?.match(/["(]https:\/\/github\.com\/(.+)\/(assets|files)\/(.+)[)"]/g) || []
      for (let n = 0; n < attachments.length; n++) {
        const targetFilename = filename.replace('{id}', (n+1).toString().padStart(attachments.length.toString().length, '0'))
        const targetPath = folder + '/' + targetFilename
        const sourceUrl = attachments[n].replace(/^["(](.+)[)"]$/, '$1')
        fs.ensureDirSync(folder)
        const realTargetFilename = basename(await downloadFile(sourceUrl, targetPath))
        files.push(realTargetFilename)
        body = body.replace(`"${sourceUrl}"`, `"${baseAttachmentPath}/${realTargetFilename}"`)
        body = body.replace(`(${sourceUrl})`, `(${baseAttachmentPath}/${realTargetFilename})`)
      }
      return resolve({ body, files })
    } catch (err) {
      return reject(err)
    }
  })
}


function migrateLegacyAttachmentPaths(filePath) {
  if (!fs.existsSync(filePath)) return false
  const content = fs.readFileSync(filePath, 'utf8')
  const updated = content.replace(/((?:\.\.?\/)+)images\/(issue|release|markdown)_/g, '$1attachments/$2_')
  if (content === updated) return false
  fs.writeFileSync(filePath, updated)
  return true
}

function readJsonSafe(path, fallback) {
  try {
    return fs.existsSync(path) ? fs.readJsonSync(path) : fallback
  } catch {
    return fallback
  }
}


function writeJSON(path, json) {
  fs.ensureDirSync(dirname(path))
  fs.writeJsonSync(path, json, { spaces: 2 })
}

function loadMetadata() {
  try {
    return fs.existsSync(metadataPath) ? fs.readJsonSync(metadataPath) : {}
  } catch {
    return {}
  }
}

function saveMetadata(metadata) {
  writeJSON(metadataPath, { version: METADATA_VERSION, ...metadata })
}

async function backup() {
  try {

    // Ensure backup folder exists (no longer wiped)
    fs.ensureDirSync(folder)

    // Load metadata from previous backup; discard if version mismatch to force full re-sync
    const metadata = loadMetadata()
    const metadataValid = metadata.version === METADATA_VERSION
    if (!metadataValid) console.log(`Metadata version mismatch (expected ${METADATA_VERSION}, got ${metadata.version ?? 'none'}) — forcing full re-sync`)
    const repoMeta = metadataValid ? (metadata.repositories || {}) : {}
    const starredMeta = metadataValid ? (metadata.starred || {}) : {}

    // Get repositories
    const repositories = await requestAllWithRetry('/user/repos')

    // Determine which repos were removed from GitHub
    const currentRepoNames = new Set(repositories.map(r => r.name))
    const existingRepoNames = new Set(Object.keys(repoMeta))
    for (const name of existingRepoNames) {
      if (!currentRepoNames.has(name)) {
        console.log(`Removing deleted repository: ${name}`)
        fs.removeSync(`${folder}/repositories/${name}`)
      }
    }

    // Save repositories
    if (fs.existsSync(`${folder}/repositories.json`)) fs.removeSync(`${folder}/repositories.json`)
    if (repositories.length > 0) writeJSON(`${folder}/repositories/repositories.json`, repositories)

    // Track new metadata
    const newRepoMeta = {}

    // Loop repositories
    for (const repository of repositories) {

      const prev = repoMeta[repository.name]
      const repoDir = `${folder}/repositories/${repository.name}`
      const repoPath = `${repoDir}/repository`
      const issuesDir = `${repoDir}/issues`
      const releasesDir = `${repoDir}/releases`
      const attachmentsDir = `${repoDir}/attachments`
      const localExists = fs.existsSync(`${repoPath}/.git`)
      const isNew = !prev || !localExists
      const codeChanged = isNew || prev.pushed_at !== repository.pushed_at
      const defaultBranch = repository.default_branch || 'main'

      // Migrate legacy images folder to attachments (markdown attachments)
      const legacyImagesDir = `${repoDir}/images`
      if (fs.existsSync(legacyImagesDir) && !fs.existsSync(attachmentsDir)) {
        console.log(`Migrating images to attachments: ${repository.name}`)
        fs.moveSync(legacyImagesDir, attachmentsDir)
      }

      // Migrate legacy issues.json to issues/issues.json
      if (fs.existsSync(`${repoDir}/issues.json`) && !fs.existsSync(`${issuesDir}/issues.json`)) {
        console.log(`Migrating issues.json location: ${repository.name}`)
        fs.ensureDirSync(issuesDir)
        fs.moveSync(`${repoDir}/issues.json`, `${issuesDir}/issues.json`)
      }

      // Migrate legacy releases.json to releases/releases.json
      if (fs.existsSync(`${repoDir}/releases.json`) && !fs.existsSync(`${releasesDir}/releases.json`)) {
        console.log(`Migrating releases.json location: ${repository.name}`)
        fs.ensureDirSync(releasesDir)
        fs.moveSync(`${repoDir}/releases.json`, `${releasesDir}/releases.json`)
      }

      // Rewrite legacy ./images/ references in stored data so old backups stay valid
      if (fs.existsSync(attachmentsDir)) {
        let pathsRewritten = false
        if (migrateLegacyAttachmentPaths(`${issuesDir}/issues.json`)) pathsRewritten = true
        if (migrateLegacyAttachmentPaths(`${releasesDir}/releases.json`)) pathsRewritten = true
        if (fs.existsSync(repoPath)) {
          for (const markdownFile of await glob(`${repoPath}/**/*.{md,MD}`)) {
            if (migrateLegacyAttachmentPaths(markdownFile)) pathsRewritten = true
          }
        }
        if (pathsRewritten) console.log(`Migrated legacy attachment paths: ${repository.name}`)
      }

      console.log(`Processing repository data: ${repository.name}`)

      // Load previously stored issues/releases to reuse data for unchanged items
      // Skip stored data on full re-sync so all attachments are re-checked
      const storedIssuesById = metadataValid ? new Map(readJsonSafe(`${issuesDir}/issues.json`, []).map(i => [i.id, i])) : new Map()
      const storedReleasesById = metadataValid ? new Map(readJsonSafe(`${releasesDir}/releases.json`, []).map(r => [r.id, r])) : new Map()

      // Get issues
      const issues = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/issues?state=all`)
      const currentIssueNumbers = new Set(issues.map(i => String(i.number)))

      // Loop issues
      for (const issue of issues) {
        const issueDir = `${issuesDir}/${issue.number}`
        const stored = storedIssuesById.get(issue.id)
        const issueChanged = !stored || stored.updated_at !== issue.updated_at

        if (!issueChanged) {
          issue.body = stored.body
          issue.comments = stored.comments
          continue
        }

        // Download issue body attachments into the per-issue folder
        const issueResult = await downloadAttachments(
          issue.body,
          issueDir,
          `body_{id}`,
          `./${issue.number}`
        )
        issue.body = issueResult.body
        const issueFiles = new Set(issueResult.files)

        // Get issue comments
        const comments = issue.comments !== 0 ? await requestAllWithRetry(issue.comments_url) : []
        issue.comments = comments

        for (const comment of comments) {
          const commentResult = await downloadAttachments(
            comment.body,
            issueDir,
            `comment_${comment.id}_{id}`,
            `./${issue.number}`
          )
          comment.body = commentResult.body
          for (const f of commentResult.files) issueFiles.add(f)
        }

        // Clean up orphaned attachments in this issue's folder
        if (fs.existsSync(issueDir)) {
          for (const file of fs.readdirSync(issueDir)) {
            if (!issueFiles.has(file)) fs.removeSync(`${issueDir}/${file}`)
          }
        }
      }

      if (issues.length > 0) {
        writeJSON(`${issuesDir}/issues.json`, issues)
        // Remove folders for deleted issues
        for (const entry of fs.readdirSync(issuesDir)) {
          if (entry === 'issues.json') continue
          const entryPath = `${issuesDir}/${entry}`
          if (fs.statSync(entryPath).isDirectory() && !currentIssueNumbers.has(entry)) {
            console.log(`Removing deleted issue: ${repository.name}#${entry}`)
            fs.removeSync(entryPath)
          }
        }
      } else if (fs.existsSync(issuesDir)) {
        console.log(`Removing issues folder (no issues): ${repository.name}`)
        fs.removeSync(issuesDir)
      }

      // Get releases
      const releases = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/releases`)
      const currentReleaseTags = new Set(releases.map(r => r.tag_name))
      const releaseExpectedFiles = new Map()

      // Loop releases
      for (const release of releases) {
        const releaseDir = `${releasesDir}/${release.tag_name}`
        const safeDownload = (url, target) => downloadFile(url, target).catch(() => {
          console.log(`... failed to download ${url}`)
        })

        // Track exactly which files belong in this release folder
        const expectedFiles = new Set()
        if (release.zipball_url) expectedFiles.add('Source code.zip')
        for (const asset of release.assets) expectedFiles.add(asset.name)

        // Download release assets and zip
        for (const asset of release.assets) {
          safeDownload(asset.url, `${releaseDir}/${asset.name}`)
        }
        if (release.zipball_url) {
          safeDownload(release.zipball_url, `${releaseDir}/Source code.zip`)
        }

        const stored = storedReleasesById.get(release.id)
        const releaseChanged = !stored || stored.updated_at !== release.updated_at

        if (!releaseChanged) {
          release.body = stored.body
          // Preserve existing numeric body attachment files
          if (fs.existsSync(releaseDir)) {
            for (const file of fs.readdirSync(releaseDir)) {
              if (/^\d+\.\w+$/.test(file)) expectedFiles.add(file)
            }
          }
        } else {
          // Download release body attachments into the release folder
          const releaseResult = await downloadAttachments(
            release.body,
            releaseDir,
            `{id}`,
            `./${release.tag_name}`
          )
          release.body = releaseResult.body
          for (const f of releaseResult.files) expectedFiles.add(f)

          // Clean up orphaned body attachments (numeric-only filenames, e.g. 01.png)
          if (fs.existsSync(releaseDir)) {
            for (const file of fs.readdirSync(releaseDir)) {
              if (/^\d+\.\w+$/.test(file) && !expectedFiles.has(file)) {
                fs.removeSync(`${releaseDir}/${file}`)
              }
            }
          }
        }

        releaseExpectedFiles.set(release.tag_name, expectedFiles)
      }

      if (releases.length > 0) {
        writeJSON(`${releasesDir}/releases.json`, releases)
        // Remove folders for deleted releases
        for (const entry of fs.readdirSync(releasesDir)) {
          if (entry === 'releases.json') continue
          const entryPath = `${releasesDir}/${entry}`
          if (fs.statSync(entryPath).isDirectory() && !currentReleaseTags.has(entry)) {
            console.log(`Removing deleted release: ${repository.name}/${entry}`)
            fs.removeSync(entryPath)
          }
        }
      } else if (fs.existsSync(releasesDir)) {
        console.log(`Removing releases folder (no releases): ${repository.name}`)
        fs.removeSync(releasesDir)
      }

      // Clean up legacy issue_* and release_* files from the attachments folder
      if (fs.existsSync(attachmentsDir)) {
        for (const file of fs.readdirSync(attachmentsDir)) {
          if (file.startsWith('issue_') || file.startsWith('release_')) {
            fs.removeSync(`${attachmentsDir}/${file}`)
          }
        }
      }

      // Clone or update git repository only if code changed
      if (codeChanged) {
        // Remove macOS AppleDouble files from pack directory to avoid "non-monotonic index" errors
        shell.exec(`find "${repoPath}/.git/objects/pack" -name '._*' -delete 2>/dev/null || true`)
        if (localExists) {
          console.log(`Updating git repository: ${repository.name}`)
          shell.exec(`git -C "${repoPath}" fetch --all && git -C "${repoPath}" reset --hard "origin/${defaultBranch}"`)
        } else {
          console.log(`Cloning git repository: ${repository.name}`)
          shell.exec(`git clone "https://${TOKEN}@github.com/${USERNAME}/${repository.name}.git" "${repoPath}"`)
        }

        // Process markdown attachments into /markdown/{relative-path}/{filename.md}/
        const repoFolder = `${repoPath}/`
        const markdownBaseDir = `${repoDir}/markdown`
        const markdownFiles = await glob(`${repoFolder}**/*.{md,MD}`)
        const activeMarkdownDirs = new Set()

        for (const markdownFile of markdownFiles) {
          const relPath = markdownFile.replace(repoFolder, '')
          const markdownAttachmentDir = `${markdownBaseDir}/${relPath}`
          const baseAttachmentPath = relative(dirname(markdownFile), markdownAttachmentDir)
          const markdownFileContent = fs.readFileSync(markdownFile, { encoding: 'utf8' })
          const markdownResult = await downloadAttachments(
            markdownFileContent,
            markdownAttachmentDir,
            `{id}`,
            baseAttachmentPath
          )

          if (markdownResult.files.length > 0) {
            activeMarkdownDirs.add(markdownAttachmentDir)
            const validFiles = new Set(markdownResult.files)
            for (const file of fs.readdirSync(markdownAttachmentDir)) {
              if (!validFiles.has(file)) fs.removeSync(`${markdownAttachmentDir}/${file}`)
            }
          }

          fs.writeFileSync(markdownFile, markdownResult.body)
        }

        // Remove markdown attachment folders for files that no longer exist or have no attachments
        const cleanMarkdownTree = (dir) => {
          if (!fs.existsSync(dir)) return false
          let hasContent = false
          for (const entry of [...fs.readdirSync(dir)]) {
            const entryPath = `${dir}/${entry}`
            if (!fs.statSync(entryPath).isDirectory()) { hasContent = true; continue }
            if (/\.(md|MD)$/.test(entry)) {
              if (activeMarkdownDirs.has(entryPath)) hasContent = true
              else fs.removeSync(entryPath)
            } else {
              if (cleanMarkdownTree(entryPath)) hasContent = true
              else fs.removeSync(entryPath)
            }
          }
          return hasContent
        }
        if (fs.existsSync(markdownBaseDir)) {
          if (!cleanMarkdownTree(markdownBaseDir)) fs.removeSync(markdownBaseDir)
        }

        // Clean up legacy markdown_* files from the attachments folder
        if (fs.existsSync(attachmentsDir)) {
          for (const file of fs.readdirSync(attachmentsDir)) {
            if (file.startsWith('markdown_')) fs.removeSync(`${attachmentsDir}/${file}`)
          }
        }

      } else {
        console.log(`Skipping unchanged git repository: ${repository.name}`)
      }

      // Remove attachments folder if now empty
      if (fs.existsSync(attachmentsDir) && fs.readdirSync(attachmentsDir).length === 0) {
        fs.removeSync(attachmentsDir)
      }

      // Remove any unexpected files or folders from the repo backup folder (recursively)
      const cleanupDir = (dir, isAllowed) => {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir)) {
          const entryPath = `${dir}/${entry}`
          const isDir = fs.statSync(entryPath).isDirectory()
          if (!isAllowed(entry, isDir)) {
            console.log(`Removing unexpected entry: ${entryPath.replace(`${repoDir}/`, `${repository.name}/`)}`)
            fs.removeSync(entryPath)
          }
        }
      }
      // Top level: only repository/, issues/, releases/, markdown/
      cleanupDir(repoDir, (e) => ['repository', 'issues', 'releases', 'markdown'].includes(e))
      // issues/: only issues.json and numeric issue-number folders
      cleanupDir(issuesDir, (e, isDir) => e === 'issues.json' || (isDir && /^\d+$/.test(e)))
      // issues/{number}/: only files, no subdirectories
      if (fs.existsSync(issuesDir)) {
        for (const entry of fs.readdirSync(issuesDir).filter(e => e !== 'issues.json')) {
          cleanupDir(`${issuesDir}/${entry}`, (_e, isDir) => !isDir)
        }
      }
      // releases/: only releases.json and tag-name folders
      cleanupDir(releasesDir, (e, isDir) => e === 'releases.json' || isDir)
      // releases/{tag}/: only files, no subdirectories
      if (fs.existsSync(releasesDir)) {
        for (const entry of fs.readdirSync(releasesDir).filter(e => e !== 'releases.json')) {
          cleanupDir(`${releasesDir}/${entry}`, (e, isDir) => !isDir && (releaseExpectedFiles.get(entry) || new Set()).has(e))
        }
      }

      // Store metadata for this repo
      newRepoMeta[repository.name] = {
        updated_at: repository.updated_at,
        pushed_at: repository.pushed_at
      }
      
      // Save metadata progressively to allow safe interruptions
      saveMetadata({
        lastBackupAt: new Date().toISOString(),
        repositories: { ...repoMeta, ...newRepoMeta },
        starred: starredMeta
      })

    }

    // Get user details
    const user = await requestJson('/user')
    if (fs.existsSync(`${folder}/user.json`)) fs.removeSync(`${folder}/user.json`)
    writeJSON(`${folder}/user/user.json`, user)
    if (user.avatar_url) {
      await downloadFile(user.avatar_url, `${folder}/user/avatar`).catch(() => {
        console.log('... failed to download user avatar')
      })
    }

    // Get starred repositories
    const starred = await requestAllWithRetry('/user/starred')
    const starredDir = `${folder}/starred`

    // Determine which starred repos were removed
    const currentStarredKeys = new Set(starred.map(r => `${r.owner.login}/${r.name}`))
    const existingStarredKeys = new Set(Object.keys(starredMeta))
    for (const key of existingStarredKeys) {
      if (!currentStarredKeys.has(key)) {
        const [owner, name] = key.split('/')
        console.log(`Removing unstarred repository: ${key}`)
        fs.removeSync(`${starredDir}/${owner}/${name}.zip`)
        const ownerDir = `${starredDir}/${owner}`
        if (fs.existsSync(ownerDir) && fs.readdirSync(ownerDir).length === 0) {
          fs.removeSync(ownerDir)
        }
      }
    }

    // Download latest source code zip for each starred repository
    const newStarredMeta = {}
    for (const repo of starred) {
      const owner = repo.owner.login
      const name = repo.name
      const key = `${owner}/${name}`
      const ownerDir = `${starredDir}/${owner}`
      const targetZip = `${ownerDir}/${name}.zip`
      const defaultBranch = repo.default_branch || 'main'
      const prev = starredMeta[key]
      const isChanged = !metadataValid || !prev || prev.pushed_at !== repo.pushed_at

      // Migrate legacy subfolder (git clone or zip-in-subdir) to flat zip
      if (fs.existsSync(`${ownerDir}/${name}`)) {
        console.log(`Removing legacy subfolder: ${key}`)
        fs.removeSync(`${ownerDir}/${name}`)
      }

      if (isChanged || !fs.existsSync(targetZip)) {
        console.log(`Downloading starred repository: ${key}`)
        fs.ensureDirSync(ownerDir)
        if (fs.existsSync(targetZip)) fs.removeSync(targetZip)
        await downloadFile(`https://api.github.com/repos/${owner}/${name}/zipball/${defaultBranch}`, targetZip).catch(() => {
          console.log(`... failed to download ${key}`)
        })
      } else {
        console.log(`Skipping unchanged starred repository: ${key}`)
      }

      newStarredMeta[key] = { pushed_at: repo.pushed_at }

      // Save metadata progressively for starred repos
      saveMetadata({
        lastBackupAt: new Date().toISOString(),
        repositories: newRepoMeta,
        starred: { ...starredMeta, ...newStarredMeta }
      })
    }

    // Save starred.json inside the starred folder (only if any starred repos exist)
    if (starred.length > 0) {
      writeJSON(`${starredDir}/starred.json`, starred)
    } else if (fs.existsSync(starredDir)) {
      console.log('Removing starred folder (no starred repositories)')
      fs.removeSync(starredDir)
    }

    // Save final complete metadata
    saveMetadata({
      lastBackupAt: new Date().toISOString(),
      repositories: newRepoMeta,
      starred: newStarredMeta
    })

    // Complete script    
    console.log('Backup completed!')
    shell.exit()

  } catch (err) {
    throw new Error(err)
  }
}

// Run the backup
backup()
