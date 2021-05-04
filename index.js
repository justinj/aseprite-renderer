const fs = require("fs");
const { inflateSync } = require("zlib");
const { PNG } = require("pngjs");

// Constants lifted from
// https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_common.h.

const ASE_FILE_MAGIC = 0xa5e0;
const ASE_FILE_FRAME_MAGIC = 0xf1fa;

const ASE_FILE_FLAG_LAYER_WITH_OPACITY = 1;

const ASE_FILE_CHUNK_FLI_COLOR2 = 4;
const ASE_FILE_CHUNK_FLI_COLOR = 11;
const ASE_FILE_CHUNK_LAYER = 0x2004;
const ASE_FILE_CHUNK_CEL = 0x2005;
const ASE_FILE_CHUNK_CEL_EXTRA = 0x2006;
const ASE_FILE_CHUNK_COLOR_PROFILE = 0x2007;
const ASE_FILE_CHUNK_MASK = 0x2016;
const ASE_FILE_CHUNK_PATH = 0x2017;
const ASE_FILE_CHUNK_TAGS = 0x2018;
const ASE_FILE_CHUNK_PALETTE = 0x2019;
const ASE_FILE_CHUNK_USER_DATA = 0x2020;
const ASE_FILE_CHUNK_SLICES = 0x2021; // Deprecated chunk (used on dev versions only between v1.2-beta7 and v1.2-beta8)
const ASE_FILE_CHUNK_SLICE = 0x2022;
const ASE_FILE_CHUNK_TILESET = 0x2023;

const ASE_FILE_LAYER_IMAGE = 0;
const ASE_FILE_LAYER_GROUP = 1;

const ASE_FILE_RAW_CEL = 0;
const ASE_FILE_LINK_CEL = 1;
const ASE_FILE_COMPRESSED_CEL = 2;

const ASE_FILE_NO_COLOR_PROFILE = 0;
const ASE_FILE_SRGB_COLOR_PROFILE = 1;
const ASE_FILE_ICC_COLOR_PROFILE = 2;

const ASE_COLOR_PROFILE_FLAG_GAMMA = 1;

const ASE_PALETTE_FLAG_HAS_NAME = 1;

const ASE_USER_DATA_FLAG_HAS_TEXT = 1;
const ASE_USER_DATA_FLAG_HAS_COLOR = 2;

const ASE_CEL_EXTRA_FLAG_PRECISE_BOUNDS = 1;

const ASE_SLICE_FLAG_HAS_CENTER_BOUNDS = 1;
const ASE_SLICE_FLAG_HAS_PIVOT_POINT = 2;

const COLORMODE_RGB = 1;
const COLORMODE_GRAYSCALE = 2;
const COLORMODE_INDEXED = 3;

const headerPos = 0;

function headerParser(input) {
  let i = 0;
  let parsed = {};
  let self = {
    nextUint(width) {
      let bytes = width / 8;

      let result = 0;
      for (let j = 0; j < bytes; j++) {
        result += input[i + j] * Math.pow(2, j * 8);
      }
      i += bytes;
      return result;
    },
    uint(name, width) {
      parsed[name] = self.nextUint(width);
      return self;
    },
    flush() {
      let old = parsed;
      parsed = {};
      return old;
    },
    seek(pos) {
      i = pos;
      return self;
    },
    jump(d) {
      i += d;
      return self;
    },
    tell() {
      return i;
    },
    sub(start, end) {
      return input.slice(start, end);
    },
  };
  return self;
}

function build(fname) {
  // https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_common.h#L57
  // https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_decoder.cpp#L247
  let parser = headerParser(fs.readFileSync(fname))
    .seek(headerPos)
    .uint("size", 32)
    .uint("magic", 16)
    .uint("frames", 16)
    .uint("width", 16)
    .uint("height", 16)
    .uint("depth", 16)
    .uint("flags", 32)
    .uint("speed", 16)
    .uint("next", 32)
    .uint("frit", 32)
    .uint("transparentIndex", 32)
    .uint("ignore0", 8)
    .uint("ignore1", 8)
    .uint("ignore2", 8)
    .uint("ncolors", 16)
    .uint("pixelWidth", 8)
    .uint("pixelHeight", 8)
    // TODO: These need to be signed ints
    .uint("gridX", 16)
    .uint("gridY", 16)
    //
    .uint("gridWidth", 16)
    .uint("gridHeight", 16);

  let header = parser.flush();
  parser.seek(headerPos + 128);

  let frames = [];

  for (let i = 0; i < header.frames; i++) {
    frames.push([...chunks(parser)]);
  }

  return {
    header,
    frames,
  };
}

// ??
function mul_un8(a, b) {
  let t = a * b + 0x80;
  return ((t >> 8) + t) >> 8;
}

function writePng(parsedAse) {
  let png = new PNG({
    width: parsedAse.header.width,
    height: parsedAse.header.height,
  });
  for (let frame of parsedAse.frames) {
    let chunks = [...frame];
    // chunks.reverse();
    for (let chunk of chunks) {
      for (let i = 0; i < chunk.data.length; i += 4) {
        let sr = chunk.data[i + 0];
        let sg = chunk.data[i + 1];
        let sb = chunk.data[i + 2];
        let sa = chunk.data[i + 3];

        let br = png.data[i + 0];
        let bg = png.data[i + 1];
        let bb = png.data[i + 2];
        let ba = png.data[i + 3];

        let ra = sa + ba - mul_un8(ba, sa);

        let rr = br + ~~(((sr - br) * sa) / ra);
        let rg = bg + ~~(((sg - bg) * sa) / ra);
        let rb = bb + ~~(((sb - bb) * sa) / ra);

        png.data[i + 0] = Math.floor(rr);
        png.data[i + 1] = Math.floor(rg);
        png.data[i + 2] = Math.floor(rb);
        png.data[i + 3] = Math.floor(ra);
      }
    }
  }
  return png;
}

module.exports = { build, writePng };

function* chunks(parser) {
  // https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_decoder.cpp#L302
  parser
    .uint("size", 32)
    .uint("magic", 16)
    .uint("chunks", 16)
    .uint("duration", 16)
    .jump(2)
    // TODO: there's some weird thing with an nchunks thing here.
    .jump(4);
  // TODO: check magic is correct.
  let frameHeader = parser.flush();
  for (let j = 0; j < frameHeader.chunks; j++) {
    let chunkPos = parser.tell();
    let chunkHeader = parser
      .uint("chunkSize", 32)
      .uint("chunkType", 16)
      .flush();
    switch (chunkHeader.chunkType) {
      case ASE_FILE_CHUNK_COLOR_PROFILE:
        readColorProfile(parser);
        break;
      case ASE_FILE_CHUNK_PALETTE:
        // TODO
        break;
      case ASE_FILE_CHUNK_FLI_COLOR2:
        // TODO
        break;
      case ASE_FILE_CHUNK_LAYER:
        // TODO
        break;
      case ASE_FILE_CHUNK_CEL:
        yield readCelChunk(parser, chunkPos, chunkHeader.chunkSize);
        break;
      default:
        console.log(
          "unhandled chunk type:",
          chunkHeader.chunkType.toString(16)
        );
    }
    parser.seek(chunkPos + chunkHeader.chunkSize);
  }
}

function readColorProfile(parser) {
  let header = parser
    .uint("type", 16)
    .uint("flags", 16)
    // this needs to be a fixed-point 32-bit integer(?)
    .uint("gamma", 32)
    .jump(8)
    .flush();
  switch (header.type) {
    case ASE_FILE_SRGB_COLOR_PROFILE:
      // TODO: not sure what this is for yet.
      break;
    default:
      console.log("unhandled color space type:", header.type.toString(16));
  }
}

function pixelFormatFromDepth(depth) {
  switch (depth) {
    case 32:
      return COLORMODE_RGB;
    case 16:
      return COLORMODE_GRAYSCALE;
    default:
      return COLORMODE_INDEXED;
  }
}

function readCelChunk(parser, chunkPos, chunkSize) {
  let header = parser
    .uint("layerIndex", 16)
    // TODO: this should be signed
    .uint("x", 16)
    .uint("y", 16)
    .uint("opacity", 8)
    .uint("celType", 16)
    .jump(7)
    .flush();

  // TODO: aesprite does some error checking here.
  switch (header.celType) {
    case ASE_FILE_COMPRESSED_CEL:
      let subheader = parser.uint("w", 16).uint("h", 16).flush();
      let imageData = parser.sub(parser.tell(), chunkPos + chunkSize);
      return {
        layerIndex: header.layerIndex,
        w: subheader.w,
        h: subheader.h,
        x: header.x,
        y: header.y,
        opacity: header.opacity,
        data: inflateSync(imageData),
        // TODO: I think this should be handled a level up instead of passed in
        // and then passed back out.
      };
    default:
      console.log("unhandled cel type");
  }
}
