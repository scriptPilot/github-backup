import fs from 'fs-extra'
import shell from 'shelljs'
import { dirname, basename } from 'path'
import fetch from 'node-fetch'
import { extension } from 'mime-types'
import credentials from './credentials.js'

const { username, token, folder } = credentials

const startTime = (new Date()).getTime()
const safetyFactor = 5
const requestPerHour = 5000 / safetyFactor
let requestNumber = 0

function wait(seconds) {
  return new Promise(resolve => {
    console.log(`... wait ${seconds}s`)
    setTimeout(() => {
      resolve()
    }, seconds * 1000)
  })
}

function request(path, options = {}) {
  return new Promise(async (resolve, reject) => {
    const baseUrl = path.substr(0, 4) !== 'http' ? 'https://api.github.com' : ''
    requestNumber++
    const allowedRequests = ( ( (new Date()).getTime() ) - startTime ) * ( requestPerHour / 3600 / 1000 )
    if (requestNumber > allowedRequests) await wait(1)
    console.log(`Request #${requestNumber}: ${baseUrl}${path}`)
    fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Token ${token}`
      },
      ...options
    })
    .then(resp => {
      resolve(resp)
    })
    .catch(err => {
      reject(err)
    })
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
        const moreItemsResponse = await request(`${path}${separator}per_page=100&page=${page}`, options) 
        const moreItems = await moreItemsResponse.json()
        if (moreItems.length) {
          items = [...items, ...moreItems]
          page = moreItems.length === 100 ? page + 1 : null
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