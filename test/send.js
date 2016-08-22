/* global it describe */
var assert = require('assert')
var fs = require('fs')

describe('Attempting to close a bad file descriptor', function () {
  it('should output a EBADF error code', function (done) {
    var fd = fs.openSync('./package.json', 'r')
    fs.createReadStream(null, {
      fd: fd,
      end: 0
    }).on('end', function () {
      fs.close(fd, function (e) {
        if (e) {
          console.log(e)
          assert.equal(e.code, 'EBADF', 'has the correct error code')
          assert.equal(Math.abs(e.errno), 9, 'has the correct error number')
          done()
        }
      })
    }).on('error', function (e) {
      console.log(e)
      assert.equal(e.code, 'EBADF', 'has the correct error code')
      assert.equal(Math.abs(e.errno), 9, 'has the correct error number')
      done()
    }).on('data', function () {})
  })
})
