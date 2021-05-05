# aseprite-renderer

This is a module to directly read the files of [aseprite](https://www.aseprite.org/) without having to manually export them to a more common format like PNG.

It's very feature-incomplete, and only has features I've needed so far.
You should probably not trust that it will faithfully render any given
aseprite file without verifying for yourself.

## Testing

```bash
$ mocha .
```

The tests will attempt to parse a number of aseprite files, output them as PNGs,
then compare the output to output generated by aseprite itself.
To add a new test case, add the `aseprite` file to `testdata/`, then run
`mocha . --regen <path to your aseprite binary>` to generate your reference PNG.
