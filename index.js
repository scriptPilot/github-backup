import fs from 'fs-extra'
import shell from 'shelljs'
import { dirname, basename } from 'path'
import fetch from 'node-fetch'
import { extension } from 'mime-types'

shell.config.fatal = true

const perPage = 100
const retryCount = 10
const retryDelayRateLimit = 6 * 60
const retryDelayOthers = 6

const { USERNAME, TOKEN } = process.env
const FOLDER = '/usr/src/backup'

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
          headers: {
            Authorization: `Token ${TOKEN}`
          },
          ...options
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
    const response = await request(sourceFileUrl)
    const ext = extension([ ...response.headers ].filter(obj => obj[0] === 'content-type')[0][1])
    targetFilePath = targetFilePath + (ext ? '.' + ext : '')
    const fileStream = fs.createWriteStream(targetFilePath)
    response.body.pipe(fileStream)
    response.body.on('error', () => { return reject() })
    fileStream.on('finish', () => {
      return resolve(targetFilePath)
    })
  })
}

function downloadAssets(body, FOLDER, filename) {
  return new Promise(async (resolve, reject) => {
    try {
      const assets = body?.match(/["(]https:\/\/github\.com\/(.+)\/assets\/(.+)[)"]/g) || []
      for (let n = 0; n < assets.length; n++) {
        const targetFilename = filename.replace('{id}', (n+1).toString().padStart(assets.length.toString().length, '0'))
        const targetPath = FOLDER + '/' + targetFilename
        const sourceUrl = assets[n].replace(/^["(](.+)[)"]$/, '$1')
        fs.ensureDirSync(FOLDER)
        const realTargetFilename = basename(await downloadFile(sourceUrl, targetPath))
        body = body.replace(`"${sourceUrl}"`, '"./assets/' + realTargetFilename + '"')
        body = body.replace(`(${sourceUrl})`, '(./assets/' + realTargetFilename + ')')
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

    // Reset the backup FOLDER
    fs.emptyDirSync(FOLDER)

    // Get repositories
    const repositories = await requestAllWithRetry('/user/repos')

    // Save repositories
    writeJSON(`${FOLDER}/repositories.json`, repositories)

    // Loop repositories
    for (const repository of repositories) {

      // Get issues
      const issues = await requestAllWithRetry(`/repos/${USERNAME}/${repository.name}/issues?state=all`)

      // Loop issues
      for (const issue of issues) {
        
        // Download issue assets
        issue.body = await downloadAssets(
          issue.body,
          `${FOLDER}/repositories/${repository.name}/assets`,
          `issue_${issue.id}_{id}`
        )

        // Get issue comments
        const comments = issue.comments !== 0 ? await requestAllWithRetry(issue.comments_url) : []

        // Add issue comments to issues JSON
        issue.comments = comments

        // Loop issue comments
        for (const comment of comments) {

          // Download issue assets
          comment.body = await downloadAssets(
            comment.body,
            `${FOLDER}/repositories/${repository.name}/assets`,
            `issue_${issue.id}_comment_${comment.id}_{id}`
          )

        }
        
      }

      // Save issues
      writeJSON(`${FOLDER}/repositories/${repository.name}/issues.json`, issues)

      // Clone repository
      shell.exec(`git clone https://${TOKEN}@github.com/${USERNAME}/${repository.name}.git ${FOLDER}/repositories/${repository.name}/repository`)

    }

    // Get user details
    const user = await requestJson('/user')
    writeJSON(`${FOLDER}/user/user.json`, user)

    // Get starred repositories
    const starred = await requestAllWithRetry('/user/starred')
    writeJSON(`${FOLDER}/user/starred.json`, starred)

    // Complete script    
    console.log('Backup completed!')
    shell.exit(1)

  } catch (err) {
    throw new Error(err)
  }
}

backup()