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
const folder = '/usr/src/backup' // Will be deleted entirely!

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
        const rateLimitRemaining = parseInt([ ...resp.headers ].filter(obj => obj[0] === 'x-ratelimit-remaining')[0][1])
        const rateLimitLimit = parseInt([ ...resp.headers ].filter(obj => obj[0] === 'x-ratelimit-limit')[0][1])
        console.log(`... failed at #${n} attempt`)
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
    try  {
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
    const response = await request(sourceFileUrl, { headers: { Accept: 'application/octet-stream' }})    
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
      const images = body?.match(/["(]https:\/\/github\.com\/(.+)\/assets\/(.+)[)"]/g) || []
      for (let n = 0; n < images.length; n++) {
        const targetFilename = filename.replace('{id}', (n+1).toString().padStart(images.length.toString().length, '0'))
        const targetPath = folder + '/' + targetFilename
        const sourceUrl = images[n].replace(/^["(](.+)[)"]$/, '$1')
        fs.ensureDirSync(folder)
        const realTargetFilename = basename(await downloadFile(sourceUrl, targetPath))
        body = body.replace(`"${sourceUrl}"`, `"${baseImagePath}/${realTargetFilename}"`)
        body = body.replace(`(${sourceUrl})`, `(${baseImagePath}/${realTargetFilename})`)
      }
      return resolve(body)
    } catch (err) {
      return reject(err)
    }
  })
}

function writeJSON(path, json) {
  fs.ensureDirSync(dirname(path))
  fs.writeJsonSync(path, json, { spaces: 2 })
}

async function backup() {
  try {

    // Reset the backup folder
    fs.emptyDirSync(folder)

    // Get repositories
    const repositories = await requestAllWithRetry('/user/repos')

    // Save repositories
    writeJSON(`${folder}/repositories.json`, repositories)

    // Loop repositories
    for (const repository of repositories) {

      // Get issues
      const issues = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/issues?state=all`)

      // Loop issues
      for (const issue of issues) {
        
        // Download issue images
        issue.body = await downloadImages(
          issue.body,
          `${folder}/repositories/${repository.name}/images`,
          `issue_${issue.id}_{id}`
        )

        // Get issue comments
        const comments = issue.comments !== 0 ? await requestAllWithRetry(issue.comments_url) : []

        // Add issue comments to issues JSON
        issue.comments = comments

        // Loop issue comments
        for (const comment of comments) {

          // Download issue comment images
          comment.body = await downloadImages(
            comment.body,
            `${folder}/repositories/${repository.name}/images`,
            `issue_${issue.id}_comment_${comment.id}_{id}`
          )

        }
        
      }

      // Save issues
      writeJSON(`${folder}/repositories/${repository.name}/issues.json`, issues)

      // Get releases
      const releases = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/releases`)

      // Loop releases
      for (const release of releases) {

        // Download release text images
        release.body = await downloadImages(
          release.body,
          `${folder}/repositories/${repository.name}/images`,
          `release_${release.id}_{id}`
        )

        // Loop release assets
        for (const asset of release.assets) {
          
          // Download release assets
          downloadFile(
            asset.url,
            `${folder}/repositories/${repository.name}/releases/${release.tag_name}/${asset.name}`
          )

        }

      }

      // Save releases
      writeJSON(`${folder}/repositories/${repository.name}/releases.json`, releases)

      // Clone repository
      shell.exec(`git clone https://${TOKEN}@github.com/${USERNAME}/${repository.name}.git ${folder}/repositories/${repository.name}/repository`)

      // Get markdown files
      const repoFolder = `${folder}/repositories/${repository.name}/repository/`
      const imageFolder = `${folder}/repositories/${repository.name}/images/`
      const markdownFiles = await glob(`${repoFolder}**/*.{md,MD}`)

      // Loop markdown files
      for (const markdownFile of markdownFiles) {

        // Download markdown images
        const baseImagePath = relative(dirname(markdownFile), imageFolder)
        const imageFileBasename = markdownFile.replace(repoFolder, '').replace(/\//g, '_').replace(/\.md$/i, '')
        let markdownFileContent = fs.readFileSync(markdownFile, { encoding: 'utf8' })
        markdownFileContent = await downloadImages(
          markdownFileContent,
          imageFolder,
          `markdown_${imageFileBasename}_{id}`,
          baseImagePath
        )

        // Update markdown file
        fs.writeFileSync(markdownFile, markdownFileContent)

      }

    }

    // Get user details
    const user = await requestJson('/user')
    writeJSON(`${folder}/user/user.json`, user)

    // Get starred repositories
    const starred = await requestAllWithRetry('/user/starred')
    writeJSON(`${folder}/user/starred.json`, starred)

    // Complete script    
    console.log('Backup completed!')
    shell.exit()

  } catch (err) {
    throw new Error(err)
  }
}

// Run the backup
backup()