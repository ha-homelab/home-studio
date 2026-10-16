#!/usr/bin/env python3
"""Render a dated validation snapshot as a portable, accessible SVG chart.

Optional documentation tool: install matplotlib, then pass a JSON input and SVG output.
It does not run tests or infer coverage; values are the recorded observations in JSON.
"""
import argparse
import json
import math
from pathlib import Path
import textwrap
import xml.etree.ElementTree as ET


def render(source, destination):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator

    data = json.loads(source.read_text(encoding='utf-8'))
    panels = data['panels']
    if not 1 <= len(panels) <= 2 or destination.suffix != '.svg':
        raise ValueError('Expected one or two panels and an SVG destination')
    for panel in panels:
        if not 1 <= len(panel['series']) <= 4:
            raise ValueError('Each panel requires one to four recorded series')
        for series in panel['series']:
            value = series['value']
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError('Counts must be finite, non-negative numbers')
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'svg.fonttype': 'none',
                         'svg.hashsalt': 'home-studio-validation', 'font.size': 12})
    fig = plt.figure(figsize=(12, 7 if len(panels) == 1 else 9.5), facecolor='#f5f8fc')
    fig.text(.055, .94, data['title'], fontsize=22, weight='bold', color='#17324d')
    fig.text(.055, .883, '\n'.join(textwrap.wrap(data['subtitle'], 108)),
             fontsize=12, color='#47627d', linespacing=1.5, va='top')
    areas = [(.29, .28, .60, .47)] if len(panels) == 1 else [(.29, .57, .60, .19), (.29, .25, .60, .19)]
    for panel, area in zip(panels, areas):
        ax = fig.add_axes(area, facecolor='#f5f8fc')
        entries = panel['series']
        positions = list(reversed(range(len(entries))))
        values = [entry['value'] for entry in entries]
        ax.barh(positions, values, height=.48, color=[entry['color'] for entry in entries], zorder=3)
        ax.set_yticks(positions, ['\n'.join(textwrap.wrap(e['label'], 23)) for e in entries], color='#17324d')
        ax.tick_params(axis='y', length=0, pad=16)
        ax.tick_params(axis='x', colors='#526e88', length=0, pad=8)
        maximum = max(values) or 1
        ax.set_xlim(0, maximum * 1.17)
        ax.set_ylim(-.6, len(entries) - .25)
        ax.xaxis.set_major_locator(MaxNLocator(nbins=6, integer=True))
        ax.grid(axis='x', color='#dce5ef', linewidth=1, zorder=0)
        ax.set_axisbelow(True)
        ax.set_xlabel(panel['unit'], color='#526e88', labelpad=12)
        ax.set_title(panel['title'], loc='left', pad=22, fontsize=15, weight='bold', color='#17324d')
        for spine in ax.spines.values():
            spine.set_visible(False)
        for position, value in zip(positions, values):
            ax.text(value + maximum * .025, position, f'{value:g}', va='center',
                    color='#17324d', weight='bold', fontsize=16)
    footnote = f"Observed {data['observed_date']}. {data['note']}"
    fig.text(.055, .105, '\n'.join(textwrap.wrap(footnote, 123)),
             color='#47627d', fontsize=10.5, va='top', linespacing=1.5)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(destination, format='svg', metadata={'Date': None, 'Creator': 'Home Studio validation chart renderer'})
    plt.close(fig)
    ns = 'http://www.w3.org/2000/svg'
    ET.register_namespace('', ns)
    ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
    tree = ET.parse(destination)
    root = tree.getroot()
    root.set('role', 'img')
    root.set('aria-labelledby', 'chart-title chart-description')
    title = ET.Element('{' + ns + '}title', id='chart-title')
    title.text = data['title']
    desc = ET.Element('{' + ns + '}desc', id='chart-description')
    desc.text = data['description']
    root.insert(0, desc)
    root.insert(0, title)
    # Matplotlib's bundled font may not be installed in a reader's browser.
    # Keep text selectable and provide local system-font fallbacks.
    for node in root.iter('{' + ns + '}text'):
        node.set('style', node.get('style', '').replace(
            "font-family: 'DejaVu Sans'", "font-family: 'DejaVu Sans', Arial, sans-serif"))
    # Rewriting through ElementTree strips the SVG DTD. The result has no
    # external resources, active content, embedded image or font dependency.
    tree.write(destination, encoding='utf-8', xml_declaration=True)
    print(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    render(args.source, args.destination)
