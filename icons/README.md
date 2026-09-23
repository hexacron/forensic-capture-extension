# Extension Icons

This directory should contain the extension icons in the following sizes:

- `icon16.png` - 16x16 pixels (toolbar icon)
- `icon48.png` - 48x48 pixels (extension management)
- `icon128.png` - 128x128 pixels (Chrome Web Store)

## Generating Icons

### Option 1: Using the Python Script

Run the icon generator script from the project root:

```bash
# Install Pillow if not already installed
pip3 install Pillow

# Run the generator
python3 generate_icons.py
```

This will create placeholder icons with a camera/capture theme.

### Option 2: Manual Creation

Create your own icons using any image editor (Photoshop, GIMP, Figma, etc.):

**Recommendations:**
- Use a camera or evidence/document theme
- Colors: Purple gradient (#667eea to #764ba2) to match the extension UI
- Keep designs simple and recognizable at small sizes
- PNG format with transparency
- Square dimensions (16x16, 48x48, 128x128)

### Option 3: Online Icon Generators

Use online tools like:
- https://www.favicon-generator.org/
- https://realfavicongenerator.net/
- https://www.iconsgenerator.com/

**Upload a design or use an icon from:**
- https://fonts.google.com/icons
- https://heroicons.com/
- https://feathericons.com/

Look for camera, screenshot, or document-related icons.

## Temporary Placeholders

Until you generate proper icons, the extension will still work but may show:
- Default extension icon in the browser
- Empty/missing icon warnings in the developer console

This won't affect functionality, only appearance.
