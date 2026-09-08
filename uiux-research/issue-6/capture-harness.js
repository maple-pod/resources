async (page) => {
  const cfg = page.__uiuxBatch
  if (!cfg)
    throw new Error('Missing page.__uiuxBatch configuration')

  const BASE = 'http://172.19.64.85:5173'
  const fixture = {
    preferences: {
      theme: cfg.theme,
      bgImage: 'none',
      volume: 0.5,
      muted: false,
      random: false,
      repeated: 'off',
    },
    liked: {
      id: 'liked',
      title: 'Liked',
      list: ['DragonDream', 'FloralLife'],
    },
    playlists: [
      {
        id: 'custom:uiux',
        title: 'UI/UX Research Playlist',
        list: ['DragonDream', 'FloralLife', 'GoPicnic', 'Nightmare'],
      },
    ],
    history: ['FloralLife', 'GoPicnic', 'Nightmare', 'RestNPeace', 'SleepyWood'],
  }

  const results = []
  const viewportName = `${cfg.width}x${cfg.height}`
  const outDir = `${cfg.outputRoot}/${cfg.theme}/${viewportName}`

  const dialogHandler = dialog => dialog.accept().catch(() => {})
  page.on('dialog', dialogHandler)

  await page.setViewportSize({ width: cfg.width, height: cfg.height })

  // Seed deterministic user-facing state once per batch.
  await page.goto(`${BASE}/playlists`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  await page.evaluate((value) => {
    localStorage.setItem('firstVisit', 'false')
    localStorage.setItem('maple-pod', JSON.stringify(value))
  }, fixture)

  async function stabilize() {
    await page.getByText('Music Player', { exact: true }).waitFor({ state: 'visible', timeout: 25000 })
    await page.waitForFunction(theme => document.body?.getAttribute('color-scheme') === theme, cfg.theme, { timeout: 10000 })
    await page.evaluate(async () => {
      if (document.fonts?.ready)
        await document.fonts.ready
      window.scrollTo(0, 0)
    })
    await page.addStyleTag({
      content: `
        #__vue-devtools-container__ { display: none !important; }
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
      `,
    })
    await page.waitForTimeout(120)
  }

  async function prepare(route) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await stabilize()
  }

  async function topMenuTrigger(side) {
    const triggers = page.locator('button[aria-haspopup="menu"]')
    const candidates = []
    for (let i = 0; i < await triggers.count(); i++) {
      const locator = triggers.nth(i)
      if (!await locator.isVisible())
        continue
      const box = await locator.boundingBox()
      if (box && box.y < 80)
        candidates.push({ locator, x: box.x })
    }
    if (candidates.length === 0)
      throw new Error(`No top menu trigger found (${side})`)
    candidates.sort((a, b) => a.x - b.x)
    return side === 'right' ? candidates.at(-1).locator : candidates[0].locator
  }

  async function openSettings() {
    const trigger = await topMenuTrigger('right')
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Theme', exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  }

  async function ensureRightPanel() {
    let queueTab = page.getByRole('tab', { name: 'Playing Queue', exact: true })
    if (await queueTab.count() > 0 && await queueTab.first().isVisible())
      return

    const toggles = page.locator('button[data-toggle]')
    let panelToggle = null
    for (let i = 0; i < await toggles.count(); i++) {
      const locator = toggles.nth(i)
      if (!await locator.isVisible())
        continue
      const box = await locator.boundingBox()
      if (box && box.width <= 32 && box.height <= 32) {
        panelToggle = locator
        break
      }
    }
    if (!panelToggle)
      throw new Error('Right-side panel toggle not found')
    await panelToggle.click()
    queueTab = page.getByRole('tab', { name: 'Playing Queue', exact: true })
    await queueTab.waitFor({ state: 'visible', timeout: 5000 })
  }

  async function screenshot(state, setup) {
    const path = `${outDir}/${state}.png`
    try {
      await setup()
      await page.waitForTimeout(120)
      await page.screenshot({ path, fullPage: false, animations: 'disabled' })
      results.push({ state, ok: true, path })
    }
    catch (error) {
      results.push({ state, ok: false, error: String(error) })
      try { await page.keyboard.press('Escape') } catch {}
    }
  }

  await screenshot('playlists', async () => {
    await prepare('/playlists')
    await page.getByText('UI/UX Research Playlist', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('playlist', async () => {
    await prepare('/playlists/all')
    await page.getByText('Dragon Dream', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('playing-queue', async () => {
    await prepare('/playlists/all')
    await page.getByRole('button', { name: /#1 Dragon Dream/ }).click()
    const audio = page.locator('audio')
    if (await audio.count())
      await audio.evaluate(el => el.pause())
    await ensureRightPanel()
    await page.getByRole('tab', { name: 'Playing Queue', exact: true }).click()
  })

  await screenshot('recent-history', async () => {
    await prepare('/playlists/all')
    await ensureRightPanel()
    await page.getByRole('tab', { name: 'Recent History', exact: true }).click()
    await page.getByText('Floral Life', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('settings-menu', async () => {
    await prepare('/playlists')
    await openSettings()
  })

  await screenshot('background-picker', async () => {
    await prepare('/playlists')
    await openSettings()
    await page.getByRole('menuitem', { name: 'Background', exact: true }).hover()
    await page.getByText('None', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('about-dialog', async () => {
    await prepare('/playlists')
    await openSettings()
    await page.getByRole('menuitem', { name: 'About', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('create-playlist-dialog', async () => {
    await prepare('/playlists')
    const title = page.getByText('Playlists', { exact: true }).first()
    await title.locator('..').locator('button').click()
    await page.getByText('Create Playlist', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('playlist-filter', async () => {
    await prepare('/playlists/all')
    await page.locator('button[aria-label="Filter by marks"]').click()
    await page.getByText('Select all', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('playlist-actions', async () => {
    await prepare('/playlists/custom:uiux')
    await page.getByText('UI/UX Research Playlist', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
    const triggers = page.locator('button[aria-haspopup="menu"]')
    const candidates = []
    for (let i = 0; i < await triggers.count(); i++) {
      const locator = triggers.nth(i)
      if (!await locator.isVisible())
        continue
      if (await locator.getAttribute('aria-label'))
        continue
      const box = await locator.boundingBox()
      if (box && box.y >= 80 && box.y < 175)
        candidates.push({ locator, x: box.x })
    }
    if (!candidates.length)
      throw new Error('Playlist actions trigger not found')
    candidates.sort((a, b) => a.x - b.x)
    await candidates.at(-1).locator.click()
    await page.getByRole('menuitem', { name: 'Edit Playlist', exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('music-actions', async () => {
    await prepare('/playlists/all')
    const row = page.locator('[data-music-src]').first()
    await row.hover()
    const trigger = row.locator('button[aria-haspopup="menu"]')
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Copy Link', exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  await screenshot('download-manager', async () => {
    await prepare('/playlists')
    const trigger = await topMenuTrigger('left')
    await trigger.click()
    await page.getByText('Dragon Dream', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
  })

  page.off('dialog', dialogHandler)
  return { config: cfg, results }
}
