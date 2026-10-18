# Asset Credits

All third-party assets below come from [Poly Haven](https://polyhaven.com) and are released under
**CC0 1.0 Universal** (public-domain dedication). Attribution is not required; it is given here as thanks.
Machine-readable details (files, real-world tile sizes, usage notes) are in `public/textures/ph/manifest.json`.

## Textures (`public/textures/ph/<id>/`)

| Slot | Asset | Author(s) | License | URL |
|---|---|---|---|---|
| ground_sand | Dense Sand | Dimitrios Savva | CC0 1.0 | https://polyhaven.com/a/dense_sand |
| ground_dirt | Mud Cracked Dry Riverbed 002 | Dimitrios Savva (photography), Dario Barresi (processing) | CC0 1.0 | https://polyhaven.com/a/mud_cracked_dry_riverbed_002 |
| plaster | Clay Block Wall | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/clay_block_wall |
| wood | Wood Planks | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/wood_planks |
| fabric | Hessian 380 | colormass (photography), Rico Cilliers (processing) | CC0 1.0 | https://polyhaven.com/a/hessian_380 |
| stone | Rough Concrete | Dimitrios Savva | CC0 1.0 | https://polyhaven.com/a/rough_concrete |
| brick_buff | White Sandstone Bricks 03 | Rob Tuytel | CC0 1.0 | https://polyhaven.com/a/white_sandstone_bricks_03 |
| bark | Palm Tree Bark | Dimitrios Savva (photography), Rico Cilliers (processing) | CC0 1.0 | https://polyhaven.com/a/palm_tree_bark |

## Models (`public/models/ph/<id>/`)

| Slot | Asset | Author(s) | License | URL |
|---|---|---|---|---|
| model_pot | Planter Pot Clay | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/planter_pot_clay |
| model_basket | Wicker Basket 02 | Kuutti Siitonen | CC0 1.0 | https://polyhaven.com/a/wicker_basket_02 |
| model_bowl | Wooden Bowl 01 | Oliver Harries | CC0 1.0 | https://polyhaven.com/a/wooden_bowl_01 |
| model_shrub | Wild Rooibos Bush | James Ray Cock (modeling), Jenelle van Heerden (photography) | CC0 1.0 | https://polyhaven.com/a/wild_rooibos_bush |
| model_grass | Grass Bermuda 01 | Rico Cilliers | CC0 1.0 | https://polyhaven.com/a/grass_bermuda_01 |

## Modifications

- The texture files are unmodified Poly Haven JPGs (a mix of 2k and 1k per set; see the manifest).
- `wild_rooibos_bush` and `grass_bermuda_01`: the `.gltf` now points base colour at Poly Haven's official
  RGBA PNG instead of the JPG, which has no alpha. Foliage materials are set to `alphaMode: MASK` (cutoff 0.5)
  so the alpha-card leaves render correctly in three.js. The unused JPG diffuse was removed.

## Reference images used for tracing (not shipped)

The relief animals are generated procedurally from outlines that were traced (as spline control points)
over these images; the images themselves are kept in `reference/` for the dev tracing page only and are
**not** part of the app build. Full table with URLs: `reference/SOURCES.md`.

| Relief | Reference | Holder | Licence |
|---|---|---|---|
| Striding lion (Processional Way) | Panel with striding lion, Met 31.13.2 | The Metropolitan Museum of Art | Public domain / CC0 (Open Access) |
| Mušḫuššu dragon (Ishtar Gate) | Glazed brick relief, Istanbul Archaeology Museums (photo by Ywpark2003) | Wikimedia Commons | CC0 1.0 |
| Aurochs (Ishtar Gate) | Glazed brick relief, Istanbul Archaeology Museums (photo by Marie-Lan Nguyen) | Wikimedia Commons | Public domain |

Other images in `reference/` (CC BY / CC BY-SA, Pedersén and Wikimedia Commons) were only looked at for layout
and colour order; nothing from them is copied into the project.

## People (`public/models/people/`)

The crowd is built from **MakeHuman** assets, all released under **CC0 1.0**, assembled headlessly in Blender
with the MPFB 2 add-on (GPL-3; used only as a build tool, not shipped). The build scripts are in
`tools/people/` (see the README there).

| Part | Asset | Pack | Author | Licence |
|---|---|---|---|---|
| Body mesh, skeleton (cmu_mb rig), eyes, eyebrows, eyelashes, skins (middle-aged / old male, middle-aged female) | MakeHuman system assets | makehuman_system_assets | MakeHuman team | CC0 1.0 |
| Hair | braid01 | makehuman_system_assets | MakeHuman team | CC0 1.0 |
| Hair | sonntag78_junglebook_hair, o4saken_long01, culturalibre_hair_02, cortu_short_messy_hair | hair01 | sonntag78, o4saken, culturalibre, cortu | CC0 1.0 |
| Beards | rehmanpolanski_beard_viking, grinsegold_beard_sigmund_wip, wdg_scruffy_beard | bodyparts05 | RehmanPolanski, grinsegold, WDG | CC0 1.0 |

Packs: https://static.makehumancommunity.org/assets/assetpacks.html (files from
https://files2.makehumancommunity.org/asset_packs/). Textures were downscaled and packed into
`people_atlas.webp`.

**Motion capture:** the walking, slow-walk, march, standing, conversation and waving clips are takes
08_01, 08_04, 20_06, 111_28, 18_08 and 111_37 of the **CMU Graphics Lab Motion Capture Database**
(http://mocap.cs.cmu.edu, *"free for all uses"*), in Bruce Hahne's MotionBuilder-friendly BVH conversion
(cgspeed; copy at https://github.com/una-dinosauria/cmu-mocap). They were retargeted onto the MakeHuman
rig, cut into seamless loops and, for the processional props, re-posed with arm IK.

Generated in this project: the Neo-Babylonian garments (robes, tunics, shawls, veils), headwear (bands,
turbans, caps, helmets), the hand-held props and all their materials.

## Fonts and libraries

| Item | Licence |
|---|---|
| Cormorant Garamond (via @fontsource) | SIL Open Font License 1.1 |
| Inter (via @fontsource-variable) | SIL Open Font License 1.1 |
| three.js r186 | MIT |
| postprocessing (pmndrs) | Zlib |
| n8ao (N8python) | ISC |

All other content — glazed-brick and paving textures, ornamental bands, relief panels, architecture, city,
date palms, garments and props of the people, sky, smoke, dust, birds and all audio — is generated
procedurally by the code in `src/` and `tools/`.
