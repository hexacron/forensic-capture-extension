#!/usr/bin/env python3
"""
Icon Generator for Forensic Data Capture Extension

This script generates placeholder icons for the extension.
Requires: pip install Pillow

Run: python3 generate_icons.py
"""

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Error: Pillow is not installed.")
    print("Please install it with: pip3 install Pillow")
    exit(1)

import os

def create_icon(size, output_path):
    """
    Create a simple icon with a camera/capture theme
    """
    # Create image with gradient background
    img = Image.new('RGB', (size, size), color='white')
    draw = ImageDraw.Draw(img)

    # Draw gradient background (purple theme)
    for y in range(size):
        # Gradient from purple to dark purple
        r = int(102 + (118 - 102) * (y / size))
        g = int(126 + (75 - 126) * (y / size))
        b = int(234 + (162 - 234) * (y / size))
        draw.rectangle([(0, y), (size, y + 1)], fill=(r, g, b))

    # Draw camera icon
    padding = size // 4
    camera_size = size - (2 * padding)

    # Camera body (rounded rectangle)
    camera_x1 = padding
    camera_y1 = padding + camera_size // 4
    camera_x2 = padding + camera_size
    camera_y2 = padding + camera_size

    draw.rounded_rectangle(
        [(camera_x1, camera_y1), (camera_x2, camera_y2)],
        radius=size // 16,
        fill='white',
        outline='white',
        width=2
    )

    # Camera lens (circle)
    lens_center_x = padding + camera_size // 2
    lens_center_y = padding + camera_size // 2 + camera_size // 8
    lens_radius = camera_size // 3

    draw.ellipse(
        [
            (lens_center_x - lens_radius, lens_center_y - lens_radius),
            (lens_center_x + lens_radius, lens_center_y + lens_radius)
        ],
        fill=None,
        outline='white',
        width=size // 32 + 1
    )

    # Inner lens circle
    inner_radius = lens_radius // 2
    draw.ellipse(
        [
            (lens_center_x - inner_radius, lens_center_y - inner_radius),
            (lens_center_x + inner_radius, lens_center_y + inner_radius)
        ],
        fill=None,
        outline='white',
        width=size // 48 + 1
    )

    # Flash (small rectangle on top right)
    flash_x = camera_x2 - camera_size // 5
    flash_y = camera_y1 - size // 16
    flash_size = size // 10

    draw.rectangle(
        [(flash_x, flash_y), (flash_x + flash_size, flash_y + flash_size)],
        fill='white'
    )

    # Save the image
    img.save(output_path, 'PNG')
    print(f"Created icon: {output_path} ({size}x{size})")


def main():
    """Generate all required icon sizes"""
    icons_dir = 'icons'

    # Create icons directory if it doesn't exist
    if not os.path.exists(icons_dir):
        os.makedirs(icons_dir)
        print(f"Created directory: {icons_dir}/")

    # Generate icons in required sizes
    sizes = [16, 48, 128]

    for size in sizes:
        output_path = os.path.join(icons_dir, f'icon{size}.png')
        create_icon(size, output_path)

    print("\nAll icons generated successfully!")
    print("Icons can be found in the 'icons/' directory.")


if __name__ == '__main__':
    main()
