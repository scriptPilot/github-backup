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
    const response = await request(sourceFileUrl, { headers: { Accept: 'application/octet-stream' }})    
    if (!extname(targetFilePath)) {
      const ext = extension([ ...response.headers ].filter(obj => obj[0] === 'content-type')[0][1])
      targetFilePath = targetFilePath + (ext ? '.' + ext : '')
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

function downloadImages(body, folder, filename, baseImagePath = './images') {
  return new Promise(async (resolve, reject) => {
    try {
      const files = []
      const images = body?.match(/["(]https:\/\/github\.com\/(.+)\/assets\/(.+)[)"]/g) || []
      for (let n = 0; n < images.length; n++) {
        const targetFilename = filename.replace('{id}', (n+1).toString().padStart(images.length.toString().length, '0'))
        const targetPath = folder + '/' + targetFilename
        const sourceUrl = images[n].replace(/^["(](.+)[)"]$/, '$1')
        fs.ensureDirSync(folder)
        const realTargetFilename = basename(await downloadFile(sourceUrl, targetPath))
        files.push(realTargetFilename)
        body = body.replace(`"${sourceUrl}"`, `"${baseImagePath}/${realTargetFilename}"`)
        body = body.replace(`(${sourceUrl})`, `(${baseImagePath}/${realTargetFilename})`)
      }
      return resolve({ body, files })
    } catch (err) {
      return reject(err)
    }
  })
}

function cleanupImages(imagesDir, prefix, keepFiles) {
  if (!fs.existsSync(imagesDir)) return
  const keepSet = new Set(keepFiles)
  for (const file of fs.readdirSync(imagesDir)) {
    if (file.startsWith(prefix) && !keepSet.has(file)) {
      console.log(`Removing orphaned image: ${file}`)
      fs.removeSync(`${imagesDir}/${file}`)
    }
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
  writeJSON(metadataPath, metadata)
}

async function backup() {
  try {

    // Ensure backup folder exists (no longer wiped)
    fs.ensureDirSync(folder)

    // Load metadata from previous backup
    const metadata = loadMetadata()
    const repoMeta = metadata.repositories || {}
    const starredMeta = metadata.starred || {}

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
    writeJSON(`${folder}/repositories.json`, repositories)

    // Track new metadata
    const newRepoMeta = {}

    // Loop repositories
    for (const repository of repositories) {

      const prev = repoMeta[repository.name]
      const repoDir = `${folder}/repositories/${repository.name}`
      const repoPath = `${repoDir}/repository`
      const localExists = fs.existsSync(`${repoPath}/.git`)
      const isNew = !prev || !localExists
      const dataChanged = isNew || prev.updated_at !== repository.updated_at
      const codeChanged = isNew || prev.pushed_at !== repository.pushed_at
      const defaultBranch = repository.default_branch || 'main'

      // Process issues and releases only if data changed
      if (dataChanged) {
        console.log(`Processing ${isNew ? 'new' : 'updated'} repository data: ${repository.name}`)

        // Get issues
        const issues = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/issues?state=all`)
        const issueImageFiles = []

        // Loop issues
        for (const issue of issues) {
          
          // Download issue images
          const issueResult = await downloadImages(
            issue.body,
            `${repoDir}/images`,
            `issue_${issue.id}_{id}`
          )
          issue.body = issueResult.body
          issueImageFiles.push(...issueResult.files)

          // Get issue comments
          const comments = issue.comments !== 0 ? await requestAllWithRetry(issue.comments_url) : []

          // Add issue comments to issues JSON
          issue.comments = comments

          // Loop issue comments
          for (const comment of comments) {

            // Download issue comment images
            const commentResult = await downloadImages(
              comment.body,
              `${repoDir}/images`,
              `issue_${issue.id}_comment_${comment.id}_{id}`
            )
            comment.body = commentResult.body
            issueImageFiles.push(...commentResult.files)

          }
          
        }

        // Save issues
        writeJSON(`${repoDir}/issues.json`, issues)

        // Clean up orphaned issue images
        cleanupImages(`${repoDir}/images`, 'issue_', issueImageFiles)

        // Get releases
        const releases = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/releases`)
        const releaseImageFiles = []

        // Loop releases
        for (const release of releases) {

          // Download release text images
          const releaseResult = await downloadImages(
            release.body,
            `${repoDir}/images`,
            `release_${release.id}_{id}`
          )
          release.body = releaseResult.body
          releaseImageFiles.push(...releaseResult.files)

          // Loop release assets
          for (const asset of release.assets) {
            
            // Download release assets (skips if file already exists)
            downloadFile(
              asset.url,
              `${repoDir}/releases/${release.tag_name}/${asset.name}`
            )

          }

        }

        // Save releases
        writeJSON(`${repoDir}/releases.json`, releases)

        // Clean up orphaned release images
        cleanupImages(`${repoDir}/images`, 'release_', releaseImageFiles)

        // Clean up release folders for removed releases
        const releasesDir = `${repoDir}/releases`
        if (fs.existsSync(releasesDir)) {
          const currentTags = new Set(releases.map(r => r.tag_name))
          for (const entry of fs.readdirSync(releasesDir)) {
            const entryPath = `${releasesDir}/${entry}`
            if (fs.statSync(entryPath).isDirectory() && !currentTags.has(entry)) {
              console.log(`Removing deleted release: ${repository.name}/${entry}`)
              fs.removeSync(entryPath)
            }
          }
        }

      } else {
        console.log(`Skipping unchanged repository data: ${repository.name}`)
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

        // Process markdown images (only after code changes since files come from the repo)
        const repoFolder = `${repoPath}/`
        const imageFolder = `${repoDir}/images/`
        const markdownFiles = await glob(`${repoFolder}**/*.{md,MD}`)
        const markdownImageFiles = []

        for (const markdownFile of markdownFiles) {

          // Download markdown images
          const baseImagePath = relative(dirname(markdownFile), imageFolder)
          const imageFileBasename = markdownFile.replace(repoFolder, '').replace(/\//g, '_').replace(/\.md$/i, '')
          let markdownFileContent = fs.readFileSync(markdownFile, { encoding: 'utf8' })
          const markdownResult = await downloadImages(
            markdownFileContent,
            imageFolder,
            `markdown_${imageFileBasename}_{id}`,
            baseImagePath
          )
          markdownImageFiles.push(...markdownResult.files)

          // Update markdown file
          fs.writeFileSync(markdownFile, markdownResult.body)

        }

        // Clean up orphaned markdown images
        cleanupImages(imageFolder, 'markdown_', markdownImageFiles)

      } else {
        console.log(`Skipping unchanged git repository: ${repository.name}`)
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
    writeJSON(`${folder}/user/user.json`, user)

    // Get starred repositories
    const starred = await requestAllWithRetry('/user/starred')
    writeJSON(`${folder}/user/starred.json`, starred)

    // Determine which starred repos were removed
    const currentStarredKeys = new Set(starred.map(r => `${r.owner.login}/${r.name}`))
    const existingStarredKeys = new Set(Object.keys(starredMeta))
    for (const key of existingStarredKeys) {
      if (!currentStarredKeys.has(key)) {
        console.log(`Removing unstarred repository: ${key}`)
        fs.removeSync(`${folder}/starred/${key}`)
        // Remove empty owner folder
        const ownerDir = `${folder}/starred/${key.split('/')[0]}`
        if (fs.existsSync(ownerDir) && fs.readdirSync(ownerDir).length === 0) {
          fs.removeSync(ownerDir)
        }
      }
    }

    // Clone or update starred repositories
    const newStarredMeta = {}
    for (const repo of starred) {
      const owner = repo.owner.login
      const name = repo.name
      const key = `${owner}/${name}`
      const targetPath = `${folder}/starred/${owner}/${name}`
      const defaultBranch = repo.default_branch || 'main'
      const prev = starredMeta[key]
      const localExists = fs.existsSync(`${targetPath}/.git`)
      const isChanged = !prev || !localExists || prev.pushed_at !== repo.pushed_at

      if (localExists && isChanged) {
        console.log(`Updating starred repository: ${key}`)
        shell.exec(`git -C "${targetPath}" fetch --depth 1 origin && git -C "${targetPath}" reset --hard "origin/${defaultBranch}"`)
      } else if (!localExists) {
        console.log(`Cloning starred repository: ${key}`)
        fs.ensureDirSync(targetPath)
        shell.exec(`git clone "https://${TOKEN}@github.com/${owner}/${name}.git" --depth 1 "${targetPath}"`)
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
