# Channel Saver

Chrome extension: YouTube channels ko niches mein save karein, aur un ki growth, outlier videos aur competitors ki har upload (exact time ke saath) track karein.

Na Node.js chahiye, na server. Sirf Google Chrome.

## Download

**[⬇ channel-saver.zip — latest version](https://github.com/buddyanalysis/Channel-Saver/releases/latest/download/channel-saver.zip)**

## Install (2 minute)

1. `channel-saver.zip` download karein → right-click → **Extract All** → **Documents** chunein.
2. Chrome mein `chrome://extensions` kholein → upar right **Developer mode** on karein.
3. **Load unpacked** dabayein → `Documents\channel-saver` folder chunein.
4. Puzzle icon 🧩 → Channel Saver ko pin karein.

YouTube par kisi bhi channel ya video par Subscribe ke saath purple **+ Save** button aayega.

## Update

Naya version aane par dashboard mein upar **"Update available"** likha aayega:

1. **Download** dabayein.
2. ZIP ko usi `channel-saver` folder par extract karein (files replace karein).
3. **Restart** dabayein.

Aap ka saara data (channels, niches, notes) save rehta hai.

## Features

- YouTube par Save button — niche dhoondhein ya naya niche likhein
- Har channel: subscribers, total views, join date, country, top & outlier videos
- Har niche ka RPM aap set karein, Opportunity score 0–100
- Rozana growth tracking aur chart
- **Competitors:** har 30 minute check — exact upload time, upload schedule (din + waqt),
  agli video kab aayegi, pehle 24 ghante ke views, views per hour, likes, title changes,
  desktop notification
- **Similar channels:** kisi bhi channel jaise doosre channels — similarity %, avg views/video,
  days since start, uploads/month, last upload, outliers, top video, ek click mein save
- **YouTube par:** har video par subscribers / outlier / views-per-hour badge, Filter panel
  (Home, Search, Subscriptions) with "Load more", channel hover preview, Shorts stats box,
  video tools (exact upload time, thumbnail download/copy, frame screenshot, transcript,
  swipe file, similar videos), channel page par Similar button
- **Swipe file:** videos, video ke hisse aur thumbnails — notes, tags, niches
- **Thumbnail tester:** apna thumbnail search results ya competitors ke beech dekhein
- **Settings:** har feature on/off
- Cards / Table view, din ke hisaab se "Recently added", search, filters
- Drag & drop: card ko niche, Competitors ya Need to look par chhodein
- CSV export, backup / import, Dark / Light mode

Saara data sirf aap ke Chrome mein rehta hai.

---

### For maintainers: releasing a new version

```powershell
powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Version 1.3.0 -Notes "What changed"
```

It sets the version in `manifest.json` and `version.json`, builds `channel-saver.zip`,
commits, pushes and publishes a GitHub release with the ZIP. Installed copies see the
update within 12 hours (or right away via "Check for updates" in the dashboard).
