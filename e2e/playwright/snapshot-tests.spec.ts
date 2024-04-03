import { test, expect, Download } from '@playwright/test'
import { secrets } from './secrets'
import { getUtils } from './test-utils'
import { Models } from '@kittycad/lib'
import fsp from 'fs/promises'
import { spawn } from 'child_process'
import { APP_NAME } from 'lib/constants'
import JSZip from 'jszip'
import path from 'path'
import { basicSettings, basicStorageState } from './storageStates'
import * as TOML from '@iarna/toml'

test.beforeEach(async ({ page }) => {
  // reducedMotion kills animations, which speeds up tests and reduces flakiness
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test.use({
  storageState: structuredClone(basicStorageState),
})

test.setTimeout(60_000)

test('exports of each format should work', async ({ page, context }) => {
  // FYI this test doesn't work with only engine running locally
  // And you will need to have the KittyCAD CLI installed
  const u = getUtils(page)
  await context.addInitScript(async () => {
    ;(window as any).playwrightSkipFilePicker = true
    localStorage.setItem(
      'persistCode',
      `const topAng = 25
const bottomAng = 35
const baseLen = 3.5
const baseHeight = 1
const totalHeightHalf = 2
const armThick = 0.5
const totalLen = 9.5
const part001 = startSketchOn('-XZ')
  |> startProfileAt([0, 0], %)
  |> yLine(baseHeight, %)
  |> xLine(baseLen, %)
  |> angledLineToY({
        angle: topAng,
        to: totalHeightHalf,
      }, %, 'seg04')
  |> xLineTo(totalLen, %, 'seg03')
  |> yLine(-armThick, %, 'seg01')
  |> angledLineThatIntersects({
        angle: HALF_TURN,
        offset: -armThick,
        intersectTag: 'seg04'
      }, %)
  |> angledLineToY([segAng('seg04', %) + 180, ZERO], %)
  |> angledLineToY({
        angle: -bottomAng,
        to: -totalHeightHalf - armThick,
      }, %, 'seg02')
  |> xLineTo(segEndX('seg03', %) + 0, %)
  |> yLine(-segLen('seg01', %), %)
  |> angledLineThatIntersects({
        angle: HALF_TURN,
        offset: -armThick,
        intersectTag: 'seg02'
      }, %)
  |> angledLineToY([segAng('seg02', %) + 180, -baseHeight], %)
  |> xLineTo(ZERO, %)
  |> close(%)
  |> extrude(4, %)`
    )
  })
  await page.setViewportSize({ width: 1200, height: 500 })
  await page.goto('/')
  await u.waitForAuthSkipAppStart()
  await u.openDebugPanel()
  await u.expectCmdLog('[data-message-type="execution-done"]')
  await u.waitForCmdReceive('extrude')
  await page.waitForTimeout(1000)
  await u.clearAndCloseDebugPanel()

  interface Paths {
    modelPath: string
    imagePath: string
    outputType: string
  }
  const doExport = async (
    output: Models['OutputFormat_type']
  ): Promise<Paths> => {
    await page.getByRole('button', { name: APP_NAME }).click()
    await expect(
      page.getByRole('button', { name: 'Export Part' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Export Part' }).click()
    await expect(page.getByTestId('command-bar')).toBeVisible()

    // Go through export via command bar
    await page.getByRole('option', { name: output.type, exact: false }).click()
    await page.locator('#arg-form').waitFor({ state: 'detached' })
    if ('storage' in output) {
      await page.getByTestId('arg-name-storage').waitFor({ timeout: 1000 })
      await page.getByRole('button', { name: 'storage', exact: false }).click()
      await page
        .getByRole('option', { name: output.storage, exact: false })
        .click()
      await page.locator('#arg-form').waitFor({ state: 'detached' })
    }
    await expect(page.getByText('Confirm Export')).toBeVisible()

    const getPromiseAndResolve = () => {
      let resolve: any = () => {}
      const promise = new Promise<Download>((r) => {
        resolve = r
      })
      return [promise, resolve]
    }

    const [downloadPromise1, downloadResolve1] = getPromiseAndResolve()
    let downloadCnt = 0

    page.on('download', async (download) => {
      if (downloadCnt === 0) {
        downloadResolve1(download)
      }
      downloadCnt++
    })
    await page.getByRole('button', { name: 'Submit command' }).click()

    // Handle download
    const download = await downloadPromise1
    const downloadLocationer = (extra = '', isImage = false) =>
      `./e2e/playwright/export-snapshots/${output.type}-${
        'storage' in output ? output.storage : ''
      }${extra}.${isImage ? 'png' : output.type}`
    const downloadLocation = downloadLocationer()

    await download.saveAs(downloadLocation)

    if (output.type === 'step') {
      // stable timestamps for step files
      const fileContents = await fsp.readFile(downloadLocation, 'utf-8')
      const newFileContents = fileContents.replace(
        /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+[0-9]+[0-9]\+[0-9]{2}:[0-9]{2}/g,
        '1970-01-01T00:00:00.0+00:00'
      )
      await fsp.writeFile(downloadLocation, newFileContents)
    }
    return {
      modelPath: downloadLocation,
      imagePath: downloadLocationer('', true),
      outputType: output.type,
    }
  }
  const axisDirectionPair: Models['AxisDirectionPair_type'] = {
    axis: 'z',
    direction: 'positive',
  }
  const sysType: Models['System_type'] = {
    forward: axisDirectionPair,
    up: axisDirectionPair,
  }

  const exportLocations: Paths[] = []

  // NOTE it was easiest to leverage existing types and have doExport take Models['OutputFormat_type'] as in input
  // just note that only `type` and `storage` are used for selecting the drop downs is the app
  // the rest are only there to make typescript happy
  exportLocations.push(
    await doExport({
      type: 'step',
      coords: sysType,
    })
  )
  exportLocations.push(
    await doExport({
      type: 'ply',
      coords: sysType,
      selection: { type: 'default_scene' },
      storage: 'ascii',
      units: 'in',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'ply',
      storage: 'binary_little_endian',
      coords: sysType,
      selection: { type: 'default_scene' },
      units: 'in',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'ply',
      storage: 'binary_big_endian',
      coords: sysType,
      selection: { type: 'default_scene' },
      units: 'in',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'stl',
      storage: 'ascii',
      coords: sysType,
      units: 'in',
      selection: { type: 'default_scene' },
    })
  )
  exportLocations.push(
    await doExport({
      type: 'stl',
      storage: 'binary',
      coords: sysType,
      units: 'in',
      selection: { type: 'default_scene' },
    })
  )
  exportLocations.push(
    await doExport({
      // obj seems to be a little flaky, times out tests sometimes
      type: 'obj',
      coords: sysType,
      units: 'in',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'gltf',
      storage: 'embedded',
      presentation: 'pretty',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'gltf',
      storage: 'binary',
      presentation: 'pretty',
    })
  )
  exportLocations.push(
    await doExport({
      type: 'gltf',
      storage: 'standard',
      presentation: 'pretty',
    })
  )

  // close page to disconnect websocket since we can only have one open atm
  await page.close()

  // snapshot exports, good compromise to capture that exports are healthy without getting bogged down in "did the formatting change" changes
  // context: https://github.com/KittyCAD/modeling-app/issues/1222
  for (let { modelPath, imagePath, outputType } of exportLocations) {
    // May change depending on the file being dealt with
    let cliCommand = `export ZOO_TOKEN=${secrets.snapshottoken} && zoo file snapshot --output-format=png --src-format=${outputType} ${modelPath} ${imagePath}`

    const parentPath = path.dirname(modelPath)

    // This is actually a zip file.
    if (modelPath.includes('gltf-standard.gltf')) {
      console.log('Extracting files from archive')
      const readZipFile = fsp.readFile(modelPath)
      const unzip = (archive: any) =>
        Object.values(archive.files).map((file: any) => ({
          name: file.name,
          promise: file.async('nodebuffer'),
        }))
      const writeFiles = (files: any) =>
        Promise.all(
          files.map((file: any) =>
            file.promise.then((data: any) => {
              console.log(`Writing ${file.name}`)
              return fsp
                .writeFile(`${parentPath}/${file.name}`, data)
                .then(() => file.name)
            })
          )
        )

      const filenames = await readZipFile
        .then(JSZip.loadAsync)
        .then(unzip)
        .then(writeFiles)
      const gltfFilename = filenames.filter((t: string) =>
        t.includes('.gltf')
      )[0]
      if (!gltfFilename) throw new Error('No output.gltf in this archive')
      cliCommand = `export ZOO_TOKEN=${secrets.snapshottoken} && zoo file snapshot --output-format=png --src-format=${outputType} ${parentPath}/${gltfFilename} ${imagePath}`
    }

    console.log(cliCommand)

    const child = spawn(cliCommand, { shell: true })
    const result = await new Promise<string>((resolve, reject) => {
      child.on('error', (code: any, msg: any) => {
        console.log('error', code, msg)
        reject('error')
      })
      child.on('exit', (code, msg) => {
        console.log('exit', code, msg)
        if (code !== 0) {
          reject(`exit code ${code} for model ${modelPath}`)
        } else {
          resolve('success')
        }
      })
      child.stderr.on('data', (data) => console.log(`stderr: ${data}`))
      child.stdout.on('data', (data) => console.log(`stdout: ${data}`))
    })
    expect(result).toBe('success')
    if (result === 'success') {
      console.log(`snapshot taken for ${modelPath}`)
    } else {
      console.log(`snapshot failed for ${modelPath}`)
    }
  }
})

test('extrude on each default plane should be stable', async ({
  page,
  context,
}) => {
  await context.addInitScript(async () => {
    localStorage.setItem(
      'SETTINGS_PERSIST_KEY',
      JSON.stringify({
        baseUnit: 'in',
        cameraControls: 'KittyCAD',
        defaultDirectory: '',
        defaultProjectName: 'project-$nnn',
        onboardingStatus: 'dismissed',
        showDebugPanel: true,
        textWrapping: 'On',
        theme: 'dark',
        unitSystem: 'imperial',
      })
    )
  })
  const u = getUtils(page)
  const makeCode = (plane = 'XY') => `const part001 = startSketchOn('${plane}')
  |> startProfileAt([7.00, 4.40], %)
  |> line([6.60, -0.20], %)
  |> line([2.80, 5.00], %)
  |> line([-5.60, 4.40], %)
  |> line([-5.40, -3.80], %)
  |> close(%)
  |> extrude(10.00, %)
`
  await context.addInitScript(async (code) => {
    localStorage.setItem('persistCode', code)
  }, makeCode('XY'))
  await page.setViewportSize({ width: 1200, height: 500 })
  await page.goto('/')
  await u.waitForAuthSkipAppStart()

  // wait for execution done
  await u.openDebugPanel()
  await u.expectCmdLog('[data-message-type="execution-done"]')
  await u.clearAndCloseDebugPanel()
  await page.waitForTimeout(200)

  const runSnapshotsForOtherPlanes = async (plane = 'XY') => {
    // clear code
    await u.removeCurrentCode()
    // add makeCode('XZ')
    await page.locator('.cm-content').fill(makeCode(plane))
    // wait for execution done
    await u.openDebugPanel()
    await u.expectCmdLog('[data-message-type="execution-done"]')
    await u.clearAndCloseDebugPanel()

    await page.getByText('Code').click()
    await page.waitForTimeout(80)
    await expect(page).toHaveScreenshot({
      maxDiffPixels: 100,
    })
    await page.getByText('Code').click()
  }
  await runSnapshotsForOtherPlanes('XY')
  await runSnapshotsForOtherPlanes('-XY')

  await runSnapshotsForOtherPlanes('XZ')
  await runSnapshotsForOtherPlanes('-XZ')

  await runSnapshotsForOtherPlanes('YZ')
  await runSnapshotsForOtherPlanes('-YZ')
})

test('Draft segments should look right', async ({ page, context }) => {
  const u = getUtils(page)
  await page.setViewportSize({ width: 1200, height: 500 })
  const PUR = 400 / 37.5 //pixeltoUnitRatio
  await page.goto('/')
  await u.waitForAuthSkipAppStart()
  await u.openDebugPanel()

  await expect(
    page.getByRole('button', { name: 'Start Sketch' })
  ).not.toBeDisabled()
  await expect(page.getByRole('button', { name: 'Start Sketch' })).toBeVisible()

  // click on "Start Sketch" button
  await u.clearCommandLogs()
  await u.doAndWaitForImageDiff(
    () => page.getByRole('button', { name: 'Start Sketch' }).click(),
    200
  )

  // select a plane
  await page.mouse.click(700, 200)

  await expect(page.locator('.cm-content')).toHaveText(
    `const part001 = startSketchOn('-XZ')`
  )

  await page.waitForTimeout(300) // TODO detect animation ending, or disable animation

  const startXPx = 600
  await page.mouse.click(startXPx + PUR * 10, 500 - PUR * 10)
  await expect(page.locator('.cm-content'))
    .toHaveText(`const part001 = startSketchOn('-XZ')
  |> startProfileAt([9.06, -12.22], %)`)
  await page.waitForTimeout(100)

  await u.closeDebugPanel()
  await page.mouse.move(startXPx + PUR * 20, 500 - PUR * 10)
  await expect(page).toHaveScreenshot({
    maxDiffPixels: 100,
  })

  await page.mouse.click(startXPx + PUR * 20, 500 - PUR * 10)
  await page.waitForTimeout(100)

  await expect(page.locator('.cm-content'))
    .toHaveText(`const part001 = startSketchOn('-XZ')
  |> startProfileAt([9.06, -12.22], %)
  |> line([9.14, 0], %)`)

  await page.getByRole('button', { name: 'Tangential Arc' }).click()

  await page.mouse.move(startXPx + PUR * 30, 500 - PUR * 20, { steps: 10 })

  await expect(page).toHaveScreenshot({
    maxDiffPixels: 100,
  })
})

test('Client side scene scale should match engine scale - Inch', async ({
  page,
}) => {
  const u = getUtils(page)
  await page.setViewportSize({ width: 1200, height: 500 })
  const PUR = 400 / 37.5 //pixeltoUnitRatio
  await page.goto('/')
  await u.waitForAuthSkipAppStart()
  await u.openDebugPanel()

  await expect(
    page.getByRole('button', { name: 'Start Sketch' })
  ).not.toBeDisabled()
  await expect(page.getByRole('button', { name: 'Start Sketch' })).toBeVisible()

  // click on "Start Sketch" button
  await u.clearCommandLogs()
  await u.doAndWaitForImageDiff(
    () => page.getByRole('button', { name: 'Start Sketch' }).click(),
    200
  )

  // select a plane
  await page.mouse.click(700, 200)

  await expect(page.locator('.cm-content')).toHaveText(
    `const part001 = startSketchOn('-XZ')`
  )

  await page.waitForTimeout(300) // TODO detect animation ending, or disable animation

  const startXPx = 600
  await page.mouse.click(startXPx + PUR * 10, 500 - PUR * 10)
  await expect(page.locator('.cm-content'))
    .toHaveText(`const part001 = startSketchOn('-XZ')
  |> startProfileAt([9.06, -12.22], %)`)
  await page.waitForTimeout(100)

  await u.closeDebugPanel()

  await page.mouse.click(startXPx + PUR * 20, 500 - PUR * 10)
  await page.waitForTimeout(100)

  await expect(page.locator('.cm-content'))
    .toHaveText(`const part001 = startSketchOn('-XZ')
  |> startProfileAt([9.06, -12.22], %)
  |> line([9.14, 0], %)`)

  await page.getByRole('button', { name: 'Tangential Arc' }).click()
  await page.waitForTimeout(100)

  await page.mouse.click(startXPx + PUR * 30, 500 - PUR * 20)

  await expect(page.locator('.cm-content'))
    .toHaveText(`const part001 = startSketchOn('-XZ')
  |> startProfileAt([9.06, -12.22], %)
  |> line([9.14, 0], %)
  |> tangentialArcTo([27.34, -3.08], %)`)

  // click tangential arc tool again to unequip it
  await page.getByRole('button', { name: 'Tangential Arc' }).click()
  await page.waitForTimeout(100)

  // screen shot should show the sketch
  await expect(page).toHaveScreenshot({
    maxDiffPixels: 100,
  })

  // exit sketch
  await u.openAndClearDebugPanel()
  await page.getByRole('button', { name: 'Exit Sketch' }).click()

  // wait for execution done
  await u.expectCmdLog('[data-message-type="execution-done"]')
  await u.clearAndCloseDebugPanel()
  await page.waitForTimeout(200)

  // second screen shot should look almost identical, i.e. scale should be the same.
  await expect(page).toHaveScreenshot({
    maxDiffPixels: 100,
  })
})

test.describe('Client side scene scale should match engine scale - Millimeters', () => {
  const storageState = structuredClone(basicStorageState)
  storageState.origins[0].localStorage[2].value = TOML.stringify({
    settings: {
      ...basicSettings,
      modeling: {
        ...basicSettings.modeling,
        defaultUnit: 'mm',
      },
    },
  })
  test.use({
    storageState,
  })

  test('Millimeters', async ({ page }) => {
    const u = getUtils(page)
    await page.setViewportSize({ width: 1200, height: 500 })
    const PUR = 400 / 37.5 //pixeltoUnitRatio
    await page.goto('/')
    await u.waitForAuthSkipAppStart()
    await u.openDebugPanel()

    await expect(
      page.getByRole('button', { name: 'Start Sketch' })
    ).not.toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Start Sketch' })
    ).toBeVisible()

    // click on "Start Sketch" button
    await u.clearCommandLogs()
    await u.doAndWaitForImageDiff(
      () => page.getByRole('button', { name: 'Start Sketch' }).click(),
      200
    )

    // select a plane
    await page.mouse.click(700, 200)

    await expect(page.locator('.cm-content')).toHaveText(
      `const part001 = startSketchOn('-XZ')`
    )

    await page.waitForTimeout(300) // TODO detect animation ending, or disable animation

    const startXPx = 600
    await page.mouse.click(startXPx + PUR * 10, 500 - PUR * 10)
    await expect(page.locator('.cm-content'))
      .toHaveText(`const part001 = startSketchOn('-XZ')
      |> startProfileAt([230.03, -310.32], %)`)
    await page.waitForTimeout(100)

    await u.closeDebugPanel()

    await page.mouse.click(startXPx + PUR * 20, 500 - PUR * 10)
    await page.waitForTimeout(100)

    await expect(page.locator('.cm-content'))
      .toHaveText(`const part001 = startSketchOn('-XZ')
      |> startProfileAt([230.03, -310.32], %)
      |> line([232.2, 0], %)`)

    await page.getByRole('button', { name: 'Tangential Arc' }).click()
    await page.waitForTimeout(100)

    await page.mouse.click(startXPx + PUR * 30, 500 - PUR * 20)

    await expect(page.locator('.cm-content'))
      .toHaveText(`const part001 = startSketchOn('-XZ')
      |> startProfileAt([230.03, -310.32], %)
      |> line([232.2, 0], %)
      |> tangentialArcTo([694.43, -78.12], %)`)

    await page.getByRole('button', { name: 'Tangential Arc' }).click()
    await page.waitForTimeout(100)

    // screen shot should show the sketch
    await expect(page).toHaveScreenshot({
      maxDiffPixels: 100,
    })

    // exit sketch
    await u.openAndClearDebugPanel()
    await page.getByRole('button', { name: 'Exit Sketch' }).click()

    // wait for execution done
    await u.expectCmdLog('[data-message-type="execution-done"]')
    await u.clearAndCloseDebugPanel()
    await page.waitForTimeout(200)

    // second screen shot should look almost identical, i.e. scale should be the same.
    await expect(page).toHaveScreenshot({
      maxDiffPixels: 100,
    })
  })
})

test('Sketch on face with none z-up', async ({ page, context }) => {
  const u = getUtils(page)
  await context.addInitScript(async () => {
    localStorage.setItem(
      'persistCode',
      `const part001 = startSketchOn('-XZ')
  |> startProfileAt([1.4, 2.47], %)
  |> line([9.31, 10.55], %, 'seg01')
  |> line([11.91, -10.42], %)
  |> close(%)
  |> extrude(5 + 7, %)
const part002 = startSketchOn(part001, 'seg01')
  |> startProfileAt([-2.89, 1.82], %)
  |> line([4.68, 3.05], %)
  |> line([0, -7.79], %, 'seg02')
  |> close(%)
  |> extrude(5 + 7, %)
`
    )
  })

  await page.setViewportSize({ width: 1200, height: 500 })
  await page.goto('/')
  await u.waitForAuthSkipAppStart()
  await expect(
    page.getByRole('button', { name: 'Start Sketch' })
  ).not.toBeDisabled()

  await page.getByRole('button', { name: 'Start Sketch' }).click()
  let previousCodeContent = await page.locator('.cm-content').innerText()

  // click at 641, 135
  await page.mouse.click(641, 135)
  await expect(page.locator('.cm-content')).not.toHaveText(previousCodeContent)
  previousCodeContent = await page.locator('.cm-content').innerText()

  await page.waitForTimeout(300)

  await expect(page).toHaveScreenshot({
    maxDiffPixels: 100,
  })
})
