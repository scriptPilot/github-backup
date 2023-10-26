import fs from 'fs-extra'
import shell from 'shelljs'
import { dirname, basename } from 'path'
import fetch from 'node-fetch'
import { extension } from 'mime-types'
import credentials from './credentials.js'

const perPage = 100
const retryCount = 10
const retryDelayRateLimit = 6 * 60
const retryDelayOthers = 6

const { username, token, folder } = credentials

function delay(seconds) {
  return new Promise(resolve => {
    console.log(`... delay ${seconds}s`)
    setTimeout(() => {
      resolve()
    }, seconds * 1000)
  })
}

function request(path, options = {}) {
  return new Promise(async (resolve, reject) => {
    const baseUrl = path.substr(0, 4) !== 'http' ? 'https://api.github.com' : ''
    console.log(`Request ${baseUrl}${path}`)
    for (let n = 1; n <= retryCount; n++) {
      const resp = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Token ${token}`
        },
        ...options
      })
      if (resp.ok) {
        resolve(resp)
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
    reject()
  })
}

function requestJson(path, options) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await request(path, options) 
      const json = await response.json()
      resolve(json)
    } catch (err) {
      reject(err)
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
      resolve(items)
    } catch (err) {
      reject(err)
    }
  })
}

function downloadFile(sourceFileUrl, targetFilePath) {
  return new Promise(async (resolve, reject) => {
    const response = await request(sourceFileUrl)
    const ext = extension([ ...response.headers ].filter(obj => obj[0] === 'content-type')[0][1])
    targetFilePath = targetFilePath + (ext ? '.' + ext : '')
    const fileStream = fs.createWriteStream(targetFilePath)
    response.body.pipe(fileStream)
    response.body.on('error', reject)
    fileStream.on('finish', () => {
      resolve(targetFilePath)
    })
  })
}

function downloadAssets(body, folder, filename) {
  return new Promise(async (resolve, reject) => {
    try {
      const assets = body?.match(/["(]https:\/\/github\.com\/(.+)\/assets\/(.+)[)"]/g) || []
      for (const assetId in assets) {
        const targetFilename = filename.replace('{id}', assetId)
        const targetPath = folder + '/' + targetFilename
        const sourceUrl = assets[assetId].replace(/^["(](.+)[)"]$/, '$1')
        fs.ensureDirSync(folder)
        const realTargetFilename = basename(await downloadFile(sourceUrl, targetPath))
        body = body.replace(`"${sourceUrl}"`, '"file://./assets/' + realTargetFilename + '"')
        body = body.replace(`(${sourceUrl})`, '(file://./assets/' + realTargetFilename + ')')
      }
      resolve(body)
    } catch (err) {
      reject(err)
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
    shell.exec(`rm -r ${folder}`)
    fs.ensureDirSync(folder)

    // Get repositories
    const repositories = await requestAll('/user/repos')

    // Save repositories
    writeJSON(`${folder}/repositories.json`, repositories)

    // Loop repositories
    for (const repository of repositories) {

      // Get issues
      const issues = await requestAll(`/repos/${username}/${repository.name}/issues?state=all`)

      // Loop issues
      for (const issueId in issues) {

        // Download issue assets
        issues[issueId].body = await downloadAssets(
          issues[issueId].body,
          `${folder}/repositories/${repository.name}/assets`,
          `issue_${issueId}_{id}`
        )

        // Get issue comments
        const comments = issues[issueId].comments !== 0 ? await requestAll(issues[issueId].comments_url) : []

        // Add issue comments to issues JSON
        issues[issueId].comments = comments

        // Loop issue comments
        for (const commentId in comments) {

          // Download issue assets
          issues[issueId].comments[commentId].body = await downloadAssets(
            issues[issueId].comments[commentId].body,
            `${folder}/repositories/${repository.name}/assets`,
            `issue_${issueId}_comment_${commentId}_{id}`
          )

        }
        
      }

      // Save issues
      writeJSON(`${folder}/repositories/${repository.name}/issues.json`, issues)

      // Clone repository
      shell.exec(`git clone https://${token}@github.com/${username}/${repository.name}.git ${folder}/repositories/${repository.name}/repository`)

    }

    // Get user details
    const user = await requestJson('/user')
    writeJSON(`${folder}/user/user.json`, user)

    // Get starred repositories
    const starred = await requestAll('/user/starred')
    writeJSON(`${folder}/user/starred.json`, starred)

    // Complete script    
    console.log('Backup completed!')
    shell.exit(1)

  } catch (err) {
    throw new Error(err)
  }
}

backup()