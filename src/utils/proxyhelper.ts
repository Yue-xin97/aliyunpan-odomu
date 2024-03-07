import { useSettingStore } from '../store'
import FlowEnc from '../module/flow-enc'
import http, { Agent as HttpAgent, IncomingMessage, Server, ServerResponse } from 'http'
import Db from './db'
import https, { Agent as HttpsAgent } from 'https'
import { GetExpiresTime } from './utils'
import { decodeName } from '../module/flow-enc/utils'
import { IAliFileItem, IAliGetFileModel } from '../aliapi/alimodels'
import { MainProxyPort } from '../layout/PageMain'
import AliFile from '../aliapi/file'
import path from 'path'
import { localPwd } from './aria2c'
import ip from 'ip'

// 默认maxFreeSockets=256
const httpsAgent = new HttpsAgent({ keepAlive: true })
const httpAgent = new HttpAgent({ keepAlive: true })

export interface IRawUrl {
  drive_id: string
  file_id: string
  url: string
  size: number
  qualities: {
    html: string
    quality: string
    height: number
    width: number
    label: string
    value: string
    url: string
  }[]
  subtitles: {
    language: string
    url: string
  }[]
}

interface FileInfo {
  user_id: string
  drive_id?: string
  file_id?: string
  file_size?: number
  encType?: string

  [key: string]: string | number | undefined
}

export function getEncType(file: IAliGetFileModel | IAliFileItem | { description: string }): string {
  let description = file.description
  if (description) {
    if (description.includes('xbyEncrypt1')) {
      return 'xbyEncrypt1'
    } else if (description.includes('xbyEncrypt2')) {
      return 'xbyEncrypt2'
    }
  }
  return ''
}

export function getEncPassword(user_id: string, encType: string, inputpassword: string = ''): string {
  if (encType) {
    if (inputpassword) {
      return inputpassword
    }
    let settingStore = useSettingStore()
    if (encType == 'xbyEncrypt1') {
      let ecnPassword = decodeName(localPwd, settingStore.securityEncType, settingStore.securityPassword)
      if (!ecnPassword) {
        ecnPassword = decodeName(user_id, settingStore.securityEncType, settingStore.securityPassword)
      }
      return ecnPassword || ''
    }
    return user_id
  }
  return ''
}

export function getFlowEnc(user_id: string, fileSize: number, encType: string, password: string = '') {
  if (!encType) return null
  let settingStore = useSettingStore()
  const securityPassword = getEncPassword(user_id, encType, password)
  const securityEncType = settingStore.securityEncType
  return new FlowEnc(securityPassword, securityEncType, fileSize)
}

export function getProxyUrl(info: FileInfo) {
  let proxyUrl = `http://${ip.address('public', 'ipv4')}:${MainProxyPort}/proxy`
  let params = Object.keys(info).filter(v => info[v])
    .map((key: string) => `${encodeURIComponent(key)}=${encodeURIComponent(info[key]!!)}`)
  return `${proxyUrl}?${params.join('&')}`
}

export function getRedirectUrl(info: FileInfo) {
  let redirectUrl = `http://${ip.address('public', 'ipv4')}:${MainProxyPort}/redirect`
  let params = Object.keys(info).filter(v => info[v])
    .map((key: string) => `${encodeURIComponent(key)}=${encodeURIComponent(info[key]!!)}`)
  return `${redirectUrl}?${params.join('&')}`
}

export async function getRawUrl(
  user_id: string,
  drive_id: string,
  file_id: string,
  encType: string = '',
  password: string = '',
  weifa: boolean = false,
  preview_type: string = '',
  quality: string = ''
): Promise<string | IRawUrl> {
  let data: any = {
    drive_id: drive_id,
    file_id: file_id,
    url: '',
    size: 0,
    qualities: [],
    subtitles: []
  }
  let { uiVideoQuality, uiVideoPlayer, securityPreviewAutoDecrypt } = useSettingStore()
  // 违规视频也使用转码播放
  if (!encType && preview_type) {
    if (weifa || preview_type === 'video' || (preview_type === 'other' && quality != 'Origin')) {
      let proxyInfo = await Db.getValueObject('ProxyInfo') as any
      if (proxyInfo && proxyInfo.encType && proxyInfo.file_id === file_id) {
        // 加密视频通过下载链接播放
      } else {
        let previewData = await AliFile.ApiVideoPreviewUrl(user_id, drive_id, file_id)
        if (typeof previewData != 'string') {
          Object.assign(data, previewData)
          if (quality && quality != 'Origin') {
            data.url = data.qualities.find((q: any) => q.quality === quality)?.url || data.qualities[0].url
          }
        }
      }
    } else if (preview_type === 'audio') {
      let audioData = await AliFile.ApiAudioPreviewUrl(user_id, drive_id, file_id)
      if (typeof audioData != 'string') {
        data.url = audioData.url
      }
    }
  }
  // 违规文件无法获取地址
  if ((!weifa && !data.url) || uiVideoPlayer == 'web') {
    let downUrl = await AliFile.ApiFileDownloadUrl(user_id, drive_id, file_id, 14400)
    if (typeof downUrl != 'string') {
      if (getUrlFileName(downUrl.url).includes('wma')) {
        return '不支持预览的加密音频格式'
      }
      if (!encType && preview_type) {
        data.qualities.unshift({ quality: 'Origin', html: '原画', label: '原画', value: '', url: downUrl.url })
      }
      data.url = downUrl.url
      data.size = downUrl.size
    } else {
      return data
    }
  }
  if (preview_type == 'other') {
    return data
  } else if (encType && securityPreviewAutoDecrypt) {
    // 代理播放
    data.url = getProxyUrl({
      user_id, drive_id, file_id, encType, password,
      file_size: data.size, quality: quality || uiVideoQuality,
      proxy_url: data.url
    })
    data.qualities.unshift({ quality: 'Origin', html: '原画', label: '原画', value: '', url: data.url })
  }
  return data
}

export function getUrlFileName(url: string) {
  let fileNameMatch = decodeURIComponent(url).match(/filename\*?=[^=;]*;?''([^&]+)/)
  if (fileNameMatch && fileNameMatch[1]) {
    return fileNameMatch[1]
  }
  return ''
}

export async function createProxyServer(port: number) {
  const url = require('url')
  const proxyServer: Server = http.createServer(async (clientReq: IncomingMessage, clientRes: ServerResponse) => {
    const { pathname, query } = url.parse(clientReq.url, true)
    const { user_id, drive_id, file_id, file_size, encType, password, weifa, quality, proxy_url } = query
    console.info('proxy query: ', query)
    if (pathname === '/proxy') {
      let proxyInfo: any = await Db.getValueObject('ProxyInfo')
      let proxyUrl = proxy_url || (proxyInfo && proxyInfo.proxy_url || '') || ''
      let { uiVideoQuality, securityEncType, securityFileNameAutoDecrypt } = useSettingStore()
      let selectQuality = quality || uiVideoQuality
      let needRefreshUrl = proxyInfo && (file_id != proxyInfo.file_id || proxyInfo.expires_time <= Date.now())
      let changeVideoQuality = proxyInfo && proxyInfo.videoQuality && (selectQuality !== proxyInfo.videoQuality)
      if (!proxyUrl || needRefreshUrl || changeVideoQuality) {
        // 获取地址
        let data = await getRawUrl(user_id, drive_id, file_id, encType, '', weifa, 'other', selectQuality)
        console.error('proxy getRawUrl', data)
        if (typeof data != 'string' && data.url) {
          let subtitleData = data.subtitles.find((sub: any) => sub.language === 'chi') || data.subtitles[0]
          let info: FileInfo = {
            user_id, drive_id, file_id, file_size, encType,
            videoQuality: selectQuality,
            expires_time: GetExpiresTime(data.url),
            proxy_url: data.url,
            subtitle_url: subtitleData && subtitleData.url || ''
          }
          await Db.saveValueObject('ProxyInfo', info)
          proxyUrl = data.url
        }
      }
      console.warn('proxyUrl', proxyUrl)
      if (!proxyUrl) {
        clientRes.writeHead(404, { 'Content-Type': 'text/plain' })
        clientRes.end()
        await Db.deleteValueObject('ProxyInfo')
        return
      }
      if (!encType) {
        // 302重定向
        clientRes.writeHead(302, { 'Location': proxyUrl })
        clientRes.end()
        return
      }
      // 是否需要解密
      let decryptTransform: any = null
      console.warn('proxy.range', clientReq.headers.range)
      // 要定位请求文件的位置 bytes=xxx-
      const range = clientReq.headers.range
      const start = range ? parseInt(range.replace('bytes=', '').split('-')[0]) : 0
      const flowEnc = getFlowEnc(user_id, file_size, encType, password)!!
      decryptTransform = flowEnc.decryptTransform()
      if (start) {
        await flowEnc.setPosition(start)
      }
      delete clientReq.headers.host
      delete clientReq.headers.referer
      delete clientReq.headers.authorization
      await new Promise((resolve, reject) => {
        // 处理请求，让下载的流量经过代理服务器
        const httpRequest = ~proxyUrl.indexOf('https') ? https : http
        const proxyServer = httpRequest.request(proxyUrl, {
          method: clientReq.method,
          headers: clientReq.headers,
          rejectUnauthorized: false,
          agent: ~proxyUrl.indexOf('https') ? httpsAgent : httpAgent
        }, (httpResp: any) => {
          console.error('httpResp.headers', httpResp.statusCode, httpResp.headers)
          clientRes.statusCode = httpResp.statusCode
          if (clientRes.statusCode % 300 < 5) {
            // 可能出现304，redirectUrl = undefined
            const redirectUrl = httpResp.headers.location || '-'
            if (decryptTransform) {
              // Referer
              httpResp.headers.location = getProxyUrl({
                user_id, drive_id, file_id, password, weifa,
                file_size, encType, quality, proxy_url
              })
            }
            console.log('302 redirectUrl:', redirectUrl)
          } else if (httpResp.headers['content-range'] && httpResp.statusCode === 200) {
            // 文件断点续传下载
            clientRes.statusCode = 206
          }
          for (const key in httpResp.headers) {
            clientRes.setHeader(key, httpResp.headers[key])
          }
          // 解密文件名
          if (clientReq.method === 'GET' && clientRes.statusCode === 200 && encType && securityFileNameAutoDecrypt) {
            let fileName = getUrlFileName(proxyUrl)
            if (fileName) {
              let ext = path.extname(fileName)
              let securityPassword = getEncPassword(user_id, encType, password)
              let decName = decodeName(securityPassword, securityEncType, fileName.replace(ext, '')) || ''
              clientRes.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(decName + ext)};`)
            }
          }
          httpResp.on('end', () => resolve(true))
          if (decryptTransform) {
            httpResp.pipe(decryptTransform).pipe(clientRes)
          } else {
            httpResp.pipe(clientRes)
          }
        })
        clientReq.pipe(proxyServer)
        // 关闭解密流
        proxyServer.on('close', async () => {
          decryptTransform && decryptTransform.destroy()
        })
        proxyServer.on('error', (e: Error) => {
          clientRes.end()
          console.log('proxyServer socket error: ' + e)
        })
        // 重定向的请求 关闭时 关闭被重定向的请求
        clientRes.on('close', async () => {
          proxyServer.destroy()
        })
      })
      clientReq.on('error', (e: Error) => {
        console.log('client socket error: ' + e)
      })
    }
  })
  proxyServer.listen(port)
  return proxyServer
}