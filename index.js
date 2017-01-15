/*!
 * send
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var createError = require('http-errors')
var debug = require('debug')('send')
var deprecate = require('depd')('send')
var destroy = require('destroy')
var encodeUrl = require('encodeurl')
var escapeHtml = require('escape-html')
var etag = require('etag')
var EventEmitter = require('events').EventEmitter
var fresh = require('fresh')
var fs = require('fs')
var mime = require('mime')
var ms = require('ms')
var onFinished = require('on-finished')
var parseRange = require('range-parser')
var path = require('path')
var statuses = require('statuses')
var Stream = require('stream')
var util = require('util')
var contentDisposition = require('content-disposition')
var Readable = require('readable-stream')

/**
 * Path function references.
 * @private
 */

var basename = path.basename
var extname = path.extname
var join = path.join
var normalize = path.normalize
var resolve = path.resolve
var sep = path.sep

/**
 * Polyfill for setImmediate
 * @private
 */

/* istanbul ignore next */
var defer = typeof setImmediate === 'function'
  ? setImmediate
  : function(fn){ process.nextTick(fn.bind.apply(fn, arguments)) }

/**
 * Internet standard newline RFC 5234 B.1
 * @private
 */

var CRLF = '\r\n'

/**
 * Regular expression for identifying a bytes Range header.
 * @private
 */

var BYTES_RANGE_REGEXP = /^ *bytes=/

/**
 * Maximum value allowed for the max age.
 * @private
 */

var MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000 // 1 year

/**
 * Regular expression to match a path with a directory up component.
 * @private
 */

var UP_PATH_REGEXP = /(?:^|[\\\/])\.\.(?:[\\\/]|$)/

/**
 * Module exports.
 * @public
 */

module.exports = SendStream
module.exports.mime = mime

/**
 * Shim EventEmitter.prototype.listenerCount for node.js < 3.2.0
 */

/* istanbul ignore next: node.js < 3.2.0 does not have a native listenerCount */
if (!EventEmitter.prototype.listenerCount) {
  EventEmitter.prototype.listenerCount = function listenerCount (type) {
    return this.listeners(type).length
  }
}

/**
 * Initialize a `SendStream` with the given `path`.
 *
 * @param {Request} req
 * @param {String} path
 * @param {object} [options]
 * @private
 */

function SendStream (req, path, options) {
  if (!(this instanceof SendStream)) return new SendStream(req, path, options)
  Stream.call(this)

  var opts = options || {}

  this.options = opts
  this.path = path
  this.req = req

  this._acceptRanges = opts.acceptRanges !== undefined
    ? Boolean(opts.acceptRanges)
    : true

  this._cacheControl = opts.cacheControl !== undefined
    ? Boolean(opts.cacheControl)
    : true

  this._etag = opts.etag !== undefined
    ? Boolean(opts.etag)
    : true

  this._dotfiles = opts.dotfiles !== undefined
    ? opts.dotfiles
    : 'ignore'

  if (this._dotfiles !== 'ignore' && this._dotfiles !== 'allow' && this._dotfiles !== 'deny') {
    throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"')
  }

  this._hidden = Boolean(opts.hidden)

  if (opts.hidden !== undefined) { /* istanbul ignore next: only a deprecation warning */
    deprecate('hidden: use dotfiles: \'' + (this._hidden ? 'allow' : 'ignore') + '\' instead')
  }

  // legacy support
  if (opts.dotfiles === undefined) {
    this._dotfiles = undefined
  }

  this._extensions = opts.extensions !== undefined
    ? normalizeList(opts.extensions, 'extensions option')
    : []

  this._index = opts.index !== undefined
    ? normalizeList(opts.index, 'index option')
    : ['index.html']

  this._lastModified = opts.lastModified !== undefined
    ? Boolean(opts.lastModified)
    : true

  this._maxage = opts.maxAge || opts.maxage
  this._maxage = typeof this._maxage === 'string'
    ? ms(this._maxage)
    : Number(this._maxage)
  this._maxage = !isNaN(this._maxage)
    ? Math.min(Math.max(0, this._maxage), MAX_MAXAGE)
    : 0

  this._root = opts.root
    ? resolve(opts.root)
    : null

  this.fd = typeof opts.fd === 'number'
    ? opts.fd
    : null

  if (!this._root && opts.from) {
    this.from(opts.from)
  }

  this.onFileSystemError = this.onFileSystemError.bind(this)
}

/**
 * Inherits from `Stream`.
 */

util.inherits(SendStream, Stream)

/**
 * Enable or disable etag generation.
 *
 * @param {Boolean} val
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.etag = deprecate.function(function etag (val) {
  this._etag = Boolean(val)
  debug('etag %s', this._etag)
  return this
}, 'send.etag: pass etag as option')

/**
 * Enable or disable "hidden" (dot) files.
 *
 * @param {Boolean} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.hidden = deprecate.function(function hidden (val) {
  this._hidden = Boolean(val)
  this._dotfiles = undefined
  debug('hidden %s', this._hidden)
  return this
}, 'send.hidden: use dotfiles option')

/**
 * Set index `paths`, set to a falsy
 * value to disable index support.
 *
 * @param {String|Boolean|Array} paths
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.index = deprecate.function(function index (paths) {
  var index = !paths ? [] : normalizeList(paths, 'paths argument')
  debug('index %o', paths)
  this._index = index
  return this
}, 'send.index: pass index as option')

/**
 * Set root `path`.
 *
 * @param {String} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.root = function root (path) {
  this._root = resolve(String(path))
  debug('root %s', this._root)
  return this
}

SendStream.prototype.from = deprecate.function(SendStream.prototype.root,
  'send.from: pass root as option')

SendStream.prototype.root = deprecate.function(SendStream.prototype.root,
  'send.root: pass root as option')

/**
 * Set max-age to `maxAge`.
 *
 * @param {Number} maxAge
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.maxage = deprecate.function(function maxage (maxAge) {
  this._maxage = typeof maxAge === 'string'
    ? ms(maxAge)
    : Number(maxAge)
  this._maxage = !isNaN(this._maxage)
    ? Math.min(Math.max(0, this._maxage), MAX_MAXAGE)
    : 0
  debug('max-age %d', this._maxage)
  return this
}, 'send.maxage: pass maxAge as option')

/**
 * Emit error with `status`.
 *
 * @param {number} status
 * @param {Error} [error]
 * @private
 */

SendStream.prototype.error = function error (status, error) {
  // emit if listeners instead of responding
  if (this.listenerCount('error') !== 0) {
    return this.emit('error', createError(error, status, {
      expose: false
    }))
  }

  var res = this.res
  var msg = statuses[status]

  // do not set headers if they have already been sent
  if (res._headerSent) return res.end()

  // clear existing headers
  clearHeaders(res)

  // add error headers
  if (error && error.headers) {
    setHeaders(res, error.headers)
  }

  // send basic response
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
  res.setHeader('Content-Length', Buffer.byteLength(msg))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(msg)
}

/**
 * Check if the pathname ends with "/".
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.hasTrailingSlash = function hasTrailingSlash () {
  return this.path[this.path.length - 1] === '/'
}

/**
 * Check if this is a conditional GET request.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isConditionalGET = function isConditionalGET () {
  return this.req.headers['if-none-match'] ||
    this.req.headers['if-modified-since']
}

/**
 * Strip content-* header fields.
 *
 * @private
 */

SendStream.prototype.removeContentHeaderFields = function removeContentHeaderFields () {
  for (var header in this.res._headers) {
    if (header.slice(0, 8) === 'content-' && header !== 'content-location') {
      this.res.removeHeader(header)
    }
  }
}

/**
 * Respond with 304 not modified.
 *
 * @api private
 */

SendStream.prototype.notModified = function notModified () {
  var res = this.res
  debug('not modified')
  this.removeContentHeaderFields()
  res.statusCode = 304
  res.end()
}

/**
 * Raise error that headers already sent.
 *
 * @api private
 */

SendStream.prototype.headersAlreadySent = function headersAlreadySent () {
  var err = new Error('Can\'t set headers after they are sent.')
  debug('headers already sent')
  this.error(500, err)
}

/**
 * Check if the request is cacheable, aka
 * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isCachable = function isCachable () {
  var statusCode = this.res.statusCode
  return (statusCode >= 200 && statusCode < 300) ||
    /* istanbul ignore next */ statusCode === 304
}

/**
 * Handle file system error.
 *
 * @param {Error} error
 * @private
 */

SendStream.prototype.onFileSystemError = function onFileSystemError (error) {
  switch (error.code) {
    case 'ENAMETOOLONG':
    case 'ENOENT':
    case 'ENOTDIR':
      this.error(404, error)
      break
    default:
      this.error(500, error)
      break
  }
}

/**
 * Check if the cache is fresh.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isFresh = function isFresh () {
  return fresh(this.req.headers, this.res._headers)
}

/**
 * Check if the range is fresh.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isRangeFresh = function isRangeFresh () {
  var ifRange = this.req.headers['if-range']

  if (!ifRange) {
    return true
  }

  return ~ifRange.indexOf('"')
    ? ~ifRange.indexOf(this.res._headers['etag'])
    : Date.parse(this.res._headers['last-modified']) <= Date.parse(ifRange)
}

/**
 * Redirect to path.
 *
 * @param {string} path
 * @private
 */

SendStream.prototype.redirect = function redirect (path) {
  if (this.listenerCount('directory')) return this.emit('directory')
  if (this.hasTrailingSlash()) return this.error(403)

  var loc = encodeUrl(collapseLeadingSlashes(path + '/'))
  var msg = 'Redirecting to <a href="' + escapeHtml(loc) + '">' + escapeHtml(loc) + '</a>\n'
  var res = this.res

  // redirect
  res.statusCode = 301
  res.setHeader('Content-Type', 'text/html; charset=UTF-8')
  res.setHeader('Content-Length', Buffer.byteLength(msg))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Location', loc)
  res.end(msg)
}

/**
 * Pipe to `res.
 *
 * @param {Stream} res
 * @return {Stream} res
 * @api public
 */

SendStream.prototype.pipe = function pipe (res) {
  // root path
  var root = this._root
  var self = this

  // references
  this.res = res

  // response finished, done with the fd
  onFinished(res, function onfinished () {
    var autoClose = self.options.autoClose !== false
    if (self._stream) self._stream.destroy()
    if (typeof self.fd === 'number' && autoClose) {
      fs.close(self.fd, function (err) {
        /* istanbul ignore next */
        if (err && err.code !== 'EBADF') return self.onFileSystemError(err)
        self.fd = null
        self.emit('close')
      })
    }
  })

  if (typeof this.fd === 'number') {
    fs.fstat(this.fd, function (err, stat) {
      if (err) return self.onFileSystemError(err)
      self.emit('file', self.path, stat)
      self.send(self.path, stat)
    })
    return res
  }

  // decode the path
  var path = decode(this.path)
  if (path === -1) {
    this.error(400)
    return res
  }

  // null byte(s)
  if (~path.indexOf('\0')) {
    this.error(400)
    return res
  }

  var parts
  if (root !== null) {
    // malicious path
    if (UP_PATH_REGEXP.test(normalize('.' + sep + path))) {
      debug('malicious path "%s"', path)
      this.error(403)
      return res
    }

    // join / normalize from optional root dir
    path = normalize(join(root, path))
    root = normalize(root + sep)

    // explode path parts
    parts = path.substr(root.length).split(sep)
  } else {
    // ".." is malicious without "root"
    if (UP_PATH_REGEXP.test(path)) {
      debug('malicious path "%s"', path)
      this.error(403)
      return res
    }

    // explode path parts
    parts = normalize(path).split(sep)

    // resolve the path
    path = resolve(path)
  }

  // dotfile handling
  if (containsDotFile(parts)) {
    var access = this._dotfiles

    // legacy support
    if (access === undefined) {
      access = parts[parts.length - 1][0] === '.'
        ? (this._hidden ? 'allow' : 'ignore')
        : 'allow'
    }

    debug('%s dotfile "%s"', access, path)
    switch (access) {
      case 'allow':
        break
      case 'deny':
        this.error(403)
        return res
      case 'ignore':
      default:
        this.error(404)
        return res
    }
  }

  // index file support
  if (this._index.length && this.path[this.path.length - 1] === '/') {
    this.sendIndex(path)
    return res
  }

  this.sendFile(path)
  return res
}

/**
 * Transfer `path`.
 *
 * @param {String} path
 * @api public
 */

SendStream.prototype.send = function send (path, stat) {
  var len = stat.size
  var options = this.options
  var opts = {}
  var res = this.res
  var req = this.req
  var ranges = req.headers.range
  var offset = options.start || 0

  if (res._header) {
    // impossible to send now
    this.headersAlreadySent()
    return
  }

  debug('pipe fd "%d" for path "%s"', this.fd, path)

  // set header fields
  this.setHeader(path, stat)

  // set content-type
  this.type(path)

  // conditional GET support
  if (this.isConditionalGET() && this.isCachable() && this.isFresh()) {
    this.notModified()
    return
  }

  // adjust len to start/end options
  len = Math.max(0, len - offset)
  if (options.end !== undefined) {
    var bytes = options.end - offset + 1
    if (len > bytes) len = bytes
  }

  // Range support
  if (this._acceptRanges && BYTES_RANGE_REGEXP.test(ranges)) {
    // parse
    ranges = parseRange(len, ranges, {
      combine: true
    })

    // If-Range support
    if (!this.isRangeFresh()) {
      debug('range stale')
      ranges = -2
    }

    // unsatisfiable
    if (ranges === -1) {
      debug('range unsatisfiable')

      // Content-Range
      res.setHeader('Content-Range', contentRange('bytes', len))

      // 416 Requested Range Not Satisfiable
      return this.error(416, {
        headers: {'Content-Range': res.getHeader('Content-Range')}
      })
    }

    // valid (syntactically invalid treated as a regular response)
    if (ranges !== -2) {
      debug('range %j', ranges)

      // Content-Range
      res.statusCode = 206

      if (ranges.length > 1) {
        opts = this.setMultipartHeader(path, stat, ranges)
        // HEAD support
        return req.method === 'HEAD'
          ? res.end()
          : this.stream(opts)
      }

      res.setHeader('Content-Range', contentRange('bytes', len, ranges[0]))
      // adjust for requested range
      offset += ranges[0].start
      len = ranges[0].end - ranges[0].start + 1
    }
  }

  // clone options
  for (var prop in options) {
    opts[prop] = options[prop]
  }

  // set read options
  opts.start = offset
  opts.end = Math.max(offset, offset + len - 1)

  // content-length
  res.setHeader('Content-Length', len)

  // HEAD support
  return req.method === 'HEAD'
    ? res.end()
    : this.stream(opts)
}

/**
 * Transfer file for `path`.
 *
 * @param {String} path
 * @api private
 */
SendStream.prototype.sendFile = function sendFile (path) {
  var i = 0
  var self = this
  var redirect = this.redirect.bind(this, this.path)

  debug('open "%s"', path)
  fs.open(path, 'r', function onopen (err, fd) {
    return !err
      ? sendStats(path, fd, self.onFileSystemError, redirect)
      : err.code === 'ENOENT' && !extname(path) && path[path.length - 1] !== sep
        ? next(err) // not found, check extensions
        : self.onFileSystemError(err)
  })

  function next (err) {
    if (self._extensions.length <= i) {
      return err
        ? self.onFileSystemError(err)
        : self.error(404)
    }
    var p = path + '.' + self._extensions[i++]
    debug('open "%s"', p)
    fs.open(p, 'r', function (err, fd) {
      if (err) return next(err)
      sendStats(p, fd, next, next)
    })
  }

  function sendStats (path, fd, onError, onDirectory) {
    debug('stat fd "%d" for path "%s"', fd, path)
    fs.fstat(fd, function onstat (err, stat) {
      if (err || stat.isDirectory()) {
        return fs.close(fd, function () { /* istanbul ignore next */
          return err ? onError(err) : onDirectory()
        })
      }
      self.fd = fd
      self.emit('file', path, stat)
      self.emit('open', fd)
      self.send(path, stat)
    })
  }
}

/**
 * Transfer index for `path`.
 *
 * @param {String} path
 * @api private
 */

SendStream.prototype.sendIndex = function sendIndex (path) {
  var i = -1
  var self = this

  return (function next (err) {
    if (++i >= self._index.length) {
      if (err) return self.onFileSystemError(err)
      return self.error(404)
    }

    var p = join(path, self._index[i])

    fs.open(p, 'r', function onopen (err, fd) {
      if (err) return next(err)
      debug('stat fd "%d" for path "%s"', fd, p)
      fs.fstat(fd, function (err, stat) {
        if (err || stat.isDirectory()) {
          return fs.close(fd, function (e) {
            next(err || e)
          })
        }
        self.fd = fd
        self.emit('file', p, stat)
        self.emit('open', fd)
        self.send(p, stat)
      })
    })
  })()
}

/**
 * Stream to the response.
 *
 * @param {Object} options
 * @api private
 */

SendStream.prototype.stream = function stream (options) {
  options.fd = this.fd
  options.autoClose = false

  if (options.ranges) {
    this._stream = new MultipartStream(options)
  } else {
    this._stream = fs.createReadStream(null, options)
    this._stream.close = this._stream.destroy = fauxClose // prevent node.js < 0.10 from closing the fd
  }

  // error
  this._stream.on('error', this.onFileSystemError)

  // end
  this._stream.on('end', this.emit.bind(this, 'end'))

  // pipe
  this.emit('stream', this._stream)
  this._stream.pipe(this.res)
}

/**
 * Set content-type based on `path`
 * if it hasn't been explicitly set.
 *
 * @param {String} path
 * @api private
 */

SendStream.prototype.type = function type (path) {
  var res = this.res

  if (res.getHeader('Content-Type')) return

  var type = mime.lookup(path)

  if (!type) {
    debug('no content-type')
    return
  }

  var charset = mime.charsets.lookup(type)

  debug('content-type %s', type)
  res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''))
}

/**
 * Set response header fields, most
 * fields may be pre-defined.
 *
 * @param {String} path
 * @param {Object} stat
 * @api private
 */

SendStream.prototype.setHeader = function setHeader (path, stat) {
  var res = this.res

  this.emit('headers', res, path, stat)

  if (this._acceptRanges && !res.getHeader('Accept-Ranges')) {
    debug('accept ranges')
    res.setHeader('Accept-Ranges', 'bytes')
  }

  if (this._cacheControl && !res.getHeader('Cache-Control')) {
    var cacheControl = 'public, max-age=' + Math.floor(this._maxage / 1000)
    debug('cache-control %s', cacheControl)
    res.setHeader('Cache-Control', cacheControl)
  }

  if (this._lastModified && !res.getHeader('Last-Modified')) {
    var modified = stat.mtime.toUTCString()
    debug('modified %s', modified)
    res.setHeader('Last-Modified', modified)
  }

  if (this._etag && !res.getHeader('ETag')) {
    var val = etag(stat)
    debug('etag %s', val)
    res.setHeader('ETag', val)
  }
}

/**
 * Set multipart headers and return options to pass to a `MultipartStream`
 *
 * @param {String} path
 * @param {Object} stat
 * @param {Array} ranges
 * @api private
 */

SendStream.prototype.setMultipartHeader = function setMultipartHeader (path, stat, ranges) {
  var res = this.res
  var type = res.getHeader('Content-Type')
  var boundary = 'BYTERANGE_' + Date.now().toString(36).toUpperCase()
  var opts = {
    ranges: ranges,
    footer: CRLF + '--' + boundary + '--',
    highWaterMark: this.options.highWaterMark || 64 * 1024
  }

  // calculate content length
  var len = opts.footer.length
  for (var i = ranges.length - 1; i >= 0; i--) {
    ranges[i].header = (
      (i ? CRLF : '') +
      '--' + boundary + CRLF +
      'Content-Type: ' + type + CRLF +
      'Content-Range: ' + contentRange('bytes', stat.size, ranges[i]) + CRLF +
      CRLF
    )
    len += ranges[i].header.length
    len += ranges[i].end - ranges[i].start + 1
  }

  // set multipart headers
  res.setHeader('Content-Length', len)
  res.setHeader('Content-Type', 'multipart/byteranges; boundary=' + boundary)
  res.setHeader('Content-Disposition', contentDisposition(path, { fallback: true }))
  return opts
}

util.inherits(MultipartStream, Readable)

function MultipartStream (opts) {
  Readable.call(this, opts)
  this.autoClose = opts.autoClose
  this.fd = opts.fd
  var self = this

  asyncSeries(opts.ranges, function sendParts (range, idx, next) {
    if (self.finished) return next(true)

    // Set ReadStream options
    range.fd = self.fd
    range.autoClose = false
    range.highWaterMark = opts.highWaterMark
    var part = self.part = fs.createReadStream(null, range)
    part.close = part.destroy = fauxClose // prevent node.js < 0.10 from closing the fd
    part.bufferSize = opts.highWaterMark

    // Set ReadStream event handlers
    part.on('error', next)
    part.on('end', next)
    part.once('data', function partHeader () { self.push(range.header, 'ascii') })
    part.on('data', function partData (data) { self.push(data) || part.pause() })
    self.emit('part', part)
  }, function sentParts (err) {
    if (self.finished) return
    if (err) {
      self.emit('error', err)
    } else {
      self.push(opts.footer)
    }
    self.close()
  })
}

MultipartStream.prototype.destroy = function destroy_MultipartStream () {
  if (this.destroyed) return
  if (this.part) this.part.destroy()
  this.destroyed = true
  this.close()
}

MultipartStream.prototype.close = function close_MultipartStream () {
  if (this.closed) return
  this.readable = !(this.finished = this.closed = !(this.part = null))
  this.push(null)
}

MultipartStream.prototype._read = function _read_MultipartStream () {
  return this.part && this.part.readable && !this.finished && this.part.resume()
}

/**
 * Clear all headers from a response.
 *
 * @param {object} res
 * @private
 */

function clearHeaders (res) {
  res._headers = {}
  res._headerNames = {}
}

/**
 * Collapse all leading slashes into a single slash
 *
 * @param {string} str
 * @private
 */
function collapseLeadingSlashes (str) {
  for (var i = 0; i < str.length; i++) {
    if (str[i] !== '/') {
      break
    }
  }

  return i > 1
    ? '/' + str.substr(i)
    : str
}

/**
 * Determine if path parts contain a dotfile.
 *
 * @api private
 */

function containsDotFile (parts) {
  for (var i = 0; i < parts.length; i++) {
    if (parts[i][0] === '.') {
      return true
    }
  }

  return false
}

/**
 * Create a Content-Range header.
 *
 * @param {string} type
 * @param {number} size
 * @param {array} [range]
 */

function contentRange (type, size, range) {
  return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size
}

/**
 * decodeURIComponent.
 *
 * Allows V8 to only deoptimize this fn instead of all
 * of send().
 *
 * @param {String} path
 * @api private
 */

function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch (err) {
    return -1
  }
}

/**
 * Normalize the index option into an array.
 *
 * @param {boolean|string|array} val
 * @param {string} name
 * @private
 */

function normalizeList (val, name) {
  var list = [].concat(val || [])

  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string') {
      throw new TypeError(name + ' must be array of strings or false')
    }
  }

  return list
}

/**
 * Set an object of headers on a response.
 *
 * @param {object} res
 * @param {object} headers
 * @private
 */

function setHeaders (res, headers) {
  var keys = Object.keys(headers)

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    res.setHeader(key, headers[key])
  }
}

/**
 * Applies the function `iteratee` to each item in `array` asynchronously in serial.
 * The iteratee is called with an item from the array, its index, and a callback (next)
 * for when it has finished. If the iteratee passes an error to its callback,
 * the main callback (done) is immediately called with the error.
 *
 * @param {array} array
 * @param {function} iteratee
 * @param {function} done
 * @private
 */

function asyncSeries (array, iteratee, done) {
  var i = 0
  var total = array.length
  return (function next (err) {
    if (err || i >= total) done(err)
    else if (i) defer(iteratee, array[i], i++, once(next))
    else iteratee(array[i], i++, once(next))
  })()
}

/**
 * Only allow a function to run once
 *
 * @param {function} fn
 * @private
 */

function once (fn) {
  var ran
  return function () {
    return ran || (ran = true, fn.apply(null, arguments))
  }
}

/**
 * A function to override ReadStream's `close` and `destroy`
 * functions to pervent it from closing the file descriptor
 *
 * @param {function} cb
 * @private
 */

function fauxClose () {
  this.readable = !(this.destroyed = this.closed = !(this.fd = null))
}
