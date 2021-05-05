const assert = require("assert");
const fs = require("fs");
const glob = require("glob");
const { PNG } = require("pngjs");
const { parse, renderedFrames } = require("./index");
const { execFile } = require("child_process");

let idx = process.argv.indexOf("--regen");

let binary = null;
if (idx > -1) {
  binary = process.argv[idx + 1];
}

function canonical(binary, from, to) {
  return new Promise(function (resolve, reject) {
    execFile(
      binary,
      ["--batch", from, "--save-as", to],
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          try {
            resolve();
          } catch (e) {
            reject(stderr);
          }
        }
      }
    );
  });
}

describe("parser", () => {
  describe("parses tag data", () => {
    it.skip("can parse the frog king sprite", () => {
      let fname = "ases/frog.ase";
      let parsed = parse(fname);
      for (let p of parsed) {
        console.log(p);
      }
    });
  });

  describe("can create pngs from ases", () => {
    for (let ase of glob.sync("testdata/*.ase")) {
      it(`handles ${ase}`, () => {
        let basename = ase.slice(0, -".ase".length);
        let outFname = basename + ".{frame}.out.png";

        let parsed = parse(ase);
        let frameCount = 0;
        for (let frame of renderedFrames(parsed)) {
          let png = new PNG({ width: frame.width, height: frame.height });
          png.data = frame.frame;
          fs.writeFileSync(
            outFname.replace("{frame}", frameCount),
            PNG.sync.write(png)
          );
          frameCount++;
        }

        let expectedFname = basename + ".{frame}.ase.png";

        let p = Promise.resolve();
        if (binary !== null) {
          p = Promise.all([canonical(binary, ase, expectedFname)]);
        }
        return p.then(() => {
          // Random formatting differences(?) mean the bytes of the actual files
          // are different so we have to load them in via pngjs and compare the
          // bytes.
          for (let i = 0; i < frameCount; i++) {
            let actual = PNG.sync.read(
              fs.readFileSync(outFname.replace("{frame}", i))
            );
            let expected = PNG.sync.read(
              fs.readFileSync(expectedFname.replace("{frame}", i))
            );

            assert.deepStrictEqual(actual.data, expected.data);
          }
        });
      });
    }
  });
});
