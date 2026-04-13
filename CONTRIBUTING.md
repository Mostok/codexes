# Contributing

## Development

```bash
npm install
npm run build
npm test
```

To verify the packaged CLI end to end:

```bash
npm run pack:tarball
npm run smoke:packaged
```

## Global CLI Check

Install the current checkout globally:

```bash
npm install -g .
codexes --help
```

## Publishing

Public npm publishing uses the scoped package name `@mostok/codexes`.

Local publish flow:

```bash
export NPM_TOKEN=YOUR_NPM_AUTOMATION_TOKEN
npm ci
npm test
npm publish --access public
```

Repository releases can also trigger `.github/workflows/publish-npm.yml` if secret `NPM_TOKEN` is configured.
