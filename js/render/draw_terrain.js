'use strict';
const mat4 = require('gl-matrix').mat4;
const EXTENT = require('../data/extent');

module.exports = drawTerrain;

//size of raster terrain tile
const TERRAIN_TILE_WIDTH = 256;
const TERRAIN_TILE_HEIGHT = 256;
const DEG2RAD = Math.PI / 180.0;


function drawTerrain(painter, sourceCache, layer, coords){
    if (painter.isOpaquePass) return;

    const gl = painter.gl;
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    painter.depthMask(true);

    // Change depth function to prevent double drawing in areas where tiles overlap.
    gl.depthFunc(gl.LESS);



    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    for (const coord of coords) {

        const tile = sourceCache.getTile(coord);
        const terrainBucket = tile.getBucket(layer);

        const texture = new TerrainTexture(gl, painter, layer, tile);
        texture.bindFramebuffer();

        if (!terrainBucket) continue;
        if (!tile.dem) {
            // set up terrain prepare textures
            tile.levels = populateLevelPixels(terrainBucket.buffers.terrainArray);
            tile.dem = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tile.dem);
            for (var i=0; i<tile.levels.length; i++){
                gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA, tile.levels[i].width, tile.levels[i].height, 0, gl.RGBA, gl.UNSIGNED_BYTE, tile.levels[i].data);
            }
        }
        tile.uploaded=true;

        if (!tile.prepared) prepareTerrain(painter, tile, texture);

        texture.unbindFramebuffer();
        texture.render(tile, layer);
    }
}

function prepareTerrain(painter, tile, texture) {
    const gl = painter.gl;
    // is this needed?
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tile.dem);


    const matrix = mat4.create();
    // Flip rendering at y axis.
    mat4.ortho(0, TERRAIN_TILE_WIDTH, -TERRAIN_TILE_HEIGHT, 0, 0, 1, matrix);
    mat4.translate(matrix, matrix, [0, -TERRAIN_TILE_HEIGHT, 0]);

    const program = painter.useProgram('terrainPrepare');

    gl.uniformMatrix4fv(program.u_matrix, false, matrix);

    gl.uniform1f(program.u_zoom, tile.coord.z);
    gl.uniform2fv(program.u_dimension, [512,512]);
    gl.uniform1i(program.u_image, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, painter.rasterBoundsBuffer);
    gl.generateMipmap(gl.TEXTURE_2D);

    tile.prepared = true;
}

// TODO create OffscreenTexture class for extrusions + terrain
// preprocessing
class TerrainTexture {
    constructor (gl, painter, layer) {
        this.gl = gl;
        this.width = TERRAIN_TILE_WIDTH;
        this.height = TERRAIN_TILE_HEIGHT;
        this.painter = painter;
        this.layer = layer;


        this.texture = null;
        this.fbo = null;
        this.fbos = this.painter.preFbos[this.width] && this.painter.preFbos[this.width][this.height];
    }

    bindFramebuffer() {
        const gl = this.gl;
        this.texture = this.painter.getViewportTexture(this.width, this.height);

        gl.activeTexture(gl.TEXTURE1);

        if (!this.texture) {
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this.texture.width = this.width;
            this.texture.height = this.height;
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
        }


        if (!this.fbos) {
            this.fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        } else {
            this.fbo = this.fbos.pop();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        }


    }

    render(tile, layer) {
        const gl = this.painter.gl;
        const program = this.painter.useProgram('terrain');
        const posMatrix = this.painter.transform.calculatePosMatrix(tile.coord);
        const azimuth = (-layer.paint["terrain-illumination-direction"] - 90) * DEG2RAD;

        gl.uniformMatrix4fv(program.u_matrix, false, posMatrix);
        gl.uniform1i(program.u_image, 0);
        gl.uniform1i(program.u_mode, 8); // todo: wtf?
        gl.uniform2fv(program.u_dimension, [256,256]);
        gl.uniform1f(program.u_zoom, tile.coord.z);
        gl.uniform1f(program.u_azimuth, azimuth);
        gl.uniform1f(program.u_zenith, 60 * DEG2RAD);
        gl.uniform1f(program.u_mipmap, 0);
        gl.uniform1f(program.u_exaggeration, layer.paint["terrain-exaggeration"]);
        gl.uniform4fv(program.u_shadow, layer.paint["terrain-shadow-color"]);
        gl.uniform4fv(program.u_highlight, layer.paint["terrain-highlight-color"]);
        gl.uniform4fv(program.u_accent, layer.paint["terrain-accent-color"]);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        const buffer = tile.boundsBuffer || this.painter.rasterBoundsBuffer;
        const vao = tile.boundsVAO || this.painter.rasterBoundsVAO;
        vao.bind(gl, program, buffer);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, buffer.length);
    }


    unbindFramebuffer() {
        this.painter.bindDefaultFramebuffer();
        if (this.fbos) {
            this.fbos.push(this.fbo);
        } else {
            if (!this.painter.preFbos[this.width]) this.painter.preFbos[this.width] = {};
            this.painter.preFbos[this.width][this.height] = [this.fbo];
        }
        this.painter.saveViewportTexture(this.texture);
    }



}

function populateLevelPixels(terrainArray) {
    let levels = [];
    let levelSize = TERRAIN_TILE_WIDTH;
    let prevIndex = 0;
    while (levelSize >= 2) {
        // levelSize * 2 = total width of texture with border
        // (levelSize *2)^2 = levelSize*levelSize*4
        // 4 = bitesPerElement for a Uint32Array
        const levelByteLength = levelSize * levelSize * 4 * 4;
        levels.push({height: levelSize*2, width:levelSize*2, data:new Uint8Array(terrainArray.arrayBuffer.slice(prevIndex,levelByteLength+prevIndex))});
        prevIndex += levelByteLength;
        levelSize /= 2;
    }
    levels.push({height: 2, width: 2, data:new Uint8Array(16)});
    levels.push({height: 1, width: 1, data:new Uint8Array(4)});
    return levels;
}
