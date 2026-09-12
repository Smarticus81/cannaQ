-- Session 42 — seed two demo recipes so the New Batch dialog has something to
-- pick from on a fresh database. Both are common edibles base recipes that map
-- naturally onto the Kitchen process_type discriminator from Session 36
-- (edibles, gummies, chocolates). They're sourced from publicly published home
-- recipes and act as starting points — operators are expected to fork into
-- production-specific versions (cannabis-infused variants, scale-up batches,
-- allergen-free swaps, etc.) by creating new recipe rows with bumped version.
--
-- Sources (kept in the notes column so auditors can trace the BOM origin):
--   * Betty Crocker Homemade Chocolate Chip Cookies
--     https://www.bettycrocker.com/recipes/homemade-chocolate-chip-cookies/77c14e03-d8b0-4844-846d-f19304f61c57
--     (recipe originally introduced 1939; current page yields ~24 cookies)
--   * Kellogg's Original Rice Krispies® Squares (Canada)
--     https://www.ricekrispies.ca/en/original-squares
--     (one 13"×9" pan; ingredient list as published 2026-05)
--
-- Conversions: source recipes mix US volume (cups, tsp), metric volume (ml, L),
-- and counts. The batch UI's unit_of_measure enum allows g/mg/units/mL/oz, so
-- volume-of-solid measurements have been converted to grams using standard
-- baking densities (flour 125 g/cup, butter 227 g/cup, granulated sugar 200
-- g/cup, packed brown sugar 220 g/cup, semisweet chocolate chips 170 g/cup,
-- chopped nuts 120 g/cup, mini marshmallows 50 g/cup, Rice Krispies cereal
-- ~28 g/cup). Egg stays in "units". Vanilla extract stays in mL. These are
-- approximations sufficient for a planned BOM — production lots should
-- re-measure on a scale.
--
-- Idempotency: both INSERTs use WHERE NOT EXISTS predicates keyed on
-- (product_name, version) for recipes and (recipe_id, ingredient_name) for
-- items. Running this migration twice is a no-op. Safe to apply to Replit
-- (before pg_dump) AND to Railway (after pg_restore) — whichever path Phase
-- 4 ends up taking.
--
-- Where this fits the data model: kind defaults to 'Ingredient' (vs 'Material'
-- which is reserved for packaging/containers per the existing code), sort_order
-- preserves the order an operator would read the ingredient list on the recipe
-- card, and is_active defaults true so both show up immediately in the New
-- Batch recipe picker.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Recipe 1 — Chocolate Chip Cookies
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO recipes (product_name, product_type, version, is_active, notes)
SELECT
  'Homemade Chocolate Chip Cookies',
  'Edible',
  1,
  true,
  'Production BOM for edibles (cookie format), scaled 5× from the Betty Crocker '
  || 'home recipe. Source: '
  || 'https://www.bettycrocker.com/recipes/homemade-chocolate-chip-cookies/77c14e03-d8b0-4844-846d-f19304f61c57. '
  || 'Yield: ~120 cookies per batch (15 min prep, 8–10 min bake at 375°F / 190°C — '
  || 'time and temperature unchanged at 5× scale; bake in multiple cookie-sheet passes). '
  || 'Fork this row (version 2+) when you build cannabis-infused production variants — '
  || 'replace the butter line with infused butter and add an Active line for the input concentrate.'
WHERE NOT EXISTS (
  SELECT 1 FROM recipes
  WHERE product_name = 'Homemade Chocolate Chip Cookies' AND version = 1
);

INSERT INTO recipe_items (recipe_id, ingredient_name, planned_quantity, unit_of_measure, kind, sort_order, notes)
SELECT r.id, item.name, item.qty, item.uom, 'Ingredient', item.sort, item.note
FROM (
  VALUES
    ('All-purpose flour',               1405::real, 'g',     1, '5 × (2 1/4 cups) = 11 1/4 cups @ ~125 g/cup'),
    ('Baking soda',                       25::real, 'g',     2, '5 × (1 tsp) = 5 tsp'),
    ('Salt',                              15::real, 'g',     3, '5 × (1/2 tsp) = 2 1/2 tsp'),
    ('Butter, softened',                1135::real, 'g',     4, '5 × (1 cup) = 5 cups'),
    ('Granulated sugar',                 750::real, 'g',     5, '5 × (3/4 cup) = 3 3/4 cups'),
    ('Brown sugar, packed',              825::real, 'g',     6, '5 × (3/4 cup) = 3 3/4 cups packed'),
    ('Egg',                                5::real, 'units', 7, '5 large eggs (~250 g total)'),
    ('Vanilla extract',                   25::real, 'mL',    8, '5 × (1 tsp) = 5 tsp'),
    ('Semisweet chocolate chips',       1700::real, 'g',     9, '5 × (2 cups) = 10 cups @ ~170 g/cup'),
    ('Chopped nuts (optional)',          600::real, 'g',    10, '5 × (1 cup) = 5 cups — optional; walnuts or pecans typical')
) AS item(name, qty, uom, sort, note)
CROSS JOIN LATERAL (
  SELECT id FROM recipes
  WHERE product_name = 'Homemade Chocolate Chip Cookies' AND version = 1
) r
WHERE NOT EXISTS (
  SELECT 1 FROM recipe_items ri
  WHERE ri.recipe_id = r.id AND ri.ingredient_name = item.name
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Recipe 2 — Rice Krispies Squares
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO recipes (product_name, product_type, version, is_active, notes)
SELECT
  'Original Rice Krispies Squares',
  'Edible',
  1,
  true,
  'Production BOM for edibles (cereal bar format), scaled 5× from the Kellogg''s '
  || 'Canada home recipe. Source: '
  || 'https://www.ricekrispies.ca/en/original-squares. '
  || 'Yield: five 13"×9" (3.5 L) pans per batch. No-bake (stovetop melt — '
  || 'method and timing unchanged at 5× scale; melt in a larger pot or do '
  || 'sequential melts to keep marshmallow temperature controlled). '
  || 'Fork this row (version 2+) for infused versions — typical pattern is to '
  || 'replace the butter line with infused butter or coconut oil and add an '
  || 'Active line for the input concentrate dose.'
WHERE NOT EXISTS (
  SELECT 1 FROM recipes
  WHERE product_name = 'Original Rice Krispies Squares' AND version = 1
);

INSERT INTO recipe_items (recipe_id, ingredient_name, planned_quantity, unit_of_measure, kind, sort_order, notes)
SELECT r.id, item.name, item.qty, item.uom, 'Ingredient', item.sort, item.note
FROM (
  VALUES
    ('Butter (or margarine)',            285::real, 'g',  1, '5 × (1/4 cup / 50 mL) = 1 1/4 cups / 250 mL — softened/melted'),
    ('Mini marshmallows',               1250::real, 'g',  2, '5 × (5 cups / 250 g pkg) = 25 cups / five 250 g packages'),
    ('Vanilla extract (optional)',        10::real, 'mL', 3, '5 × (1/2 tsp) = 2 1/2 tsp — enhances flavor, not required'),
    ('Rice Krispies cereal',             825::real, 'g',  4, '5 × (6 cups) = 30 cups @ ~28 g/cup')
) AS item(name, qty, uom, sort, note)
CROSS JOIN LATERAL (
  SELECT id FROM recipes
  WHERE product_name = 'Original Rice Krispies Squares' AND version = 1
) r
WHERE NOT EXISTS (
  SELECT 1 FROM recipe_items ri
  WHERE ri.recipe_id = r.id AND ri.ingredient_name = item.name
);

COMMIT;
