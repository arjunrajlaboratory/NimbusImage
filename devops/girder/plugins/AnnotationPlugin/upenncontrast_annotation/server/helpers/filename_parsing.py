"""Pure-Python port of ``collectFilenameMetadata2`` from
``src/utils/parsing.ts``.

The frontend tokenizes uploaded filenames and guesses which token
"columns" correspond to which acquisition dimension (XY / Z / T / C).
This module mirrors that behaviour exactly so the backend can generate
the same multi-source configuration without the browser.

Fidelity notes (JS semantics that are reproduced here):

* Filenames are tokenized on ``[_./]``. Rows are ragged; a missing token
  behaves like JS ``undefined`` (represented as ``None``). ``undefined``
  is a distinct value and JS ``Array.sort`` places it LAST, so sort keys
  use ``(token is None, token)``.
* Rows are sorted by filename. Row order provably does not change the
  final output (values are re-sorted downstream), but it is mirrored for
  fidelity because ``findCommonSubstring`` reads ``tokens[0]``.
* Column combinations are enumerated in the exact order of the JS
  ``getCombinations`` helper (sizes 1..n; for each size the head element
  walks left to right and recurses on the tail).
* dataframe-js ``findAllComplementaryColumns`` returns, for each minimal
  column, ``[column, ...complementary]``. Only ``list[0]`` (the minimal
  column itself) is ever used downstream, and the number of lists equals
  ``len(minimalColumns)``. The complementary columns therefore cannot
  affect the output, so they are not computed here. The only observable
  consequence of that computation -- the ``length > 4`` guard in
  ``assignUniqueCategorizations`` -- is preserved as
  ``len(minimal_columns) > 4``.
* Categorization triggers are scanned in insertion order (z, xy, chan, t)
  and conflicts are resolved against ``["chan", "xy", "z", "t"]``.
* Error paths are silent (return ``[]`` / skip), never raising.
"""

import re

# Pattern used to split filenames into tokens (underscores, dots, slashes)
FILENAME_DELIMITER = re.compile(r"[_./]")

# Insertion order matters: categories are scanned z, xy, chan, t.
TRIGGERS_PER_CATEGORY = {
    "z": ["z", "slice"],
    "xy": ["well", "stage", "pos"],
    "chan": ["chan", "channel", "fp", "ch"],
    "t": ["t", "time", "sec", "msec", "ms", "d", "m", "hr", "h"],
}

_XY_PATTERN = re.compile(r"^[A-Za-z]\d{1,2}$")
_DIGIT_PATTERN = re.compile(r"\d")

_ASSIGNMENT_TO_LETTER = {"chan": "C", "t": "T", "xy": "XY", "z": "Z"}

# Category order used to resolve conflicts (JS baseCategorizations).
_BASE_CATEGORIES = ["chan", "xy", "z", "t"]


def _js_str(token):
    """Mirror JS string coercion of a token for regex tests.

    In JS ``regex.test(undefined)`` coerces ``undefined`` to the string
    ``"undefined"``. ``None`` here stands for ``undefined``.
    """
    return "undefined" if token is None else token


def _tokenize(filenames):
    """Return ragged rows ``[filename, token1, token2, ...]`` sorted by
    filename (ascending, matching ``df.sortBy('Filename')``)."""
    rows = [[name] + FILENAME_DELIMITER.split(name) for name in filenames]
    rows.sort(key=lambda row: row[0])
    return rows


def _column_value(row, col):
    """Token at column index ``col`` (1-based token position), or ``None``
    when the row has fewer tokens (JS ``undefined``)."""
    return row[col] if col < len(row) else None


def _distinct_count(rows, col):
    """Number of distinct values in a column, counting ``None`` once."""
    return len({_column_value(row, col) for row in rows})


def _get_combinations(elements, size):
    """Port of the JS ``getCombinations`` helper (same emission order)."""
    if size == 1:
        return [[element] for element in elements]
    combinations = []
    for i in range(len(elements) - size + 1):
        head = elements[i]
        for tail in _get_combinations(elements[i + 1:], size - 1):
            combinations.append([head] + tail)
    return combinations


def _find_minimal_spanning_columns(rows, columns):
    """First column combination whose distinct-value product equals the
    number of rows, in JS enumeration order.

    The frontend searches every subset, which is 2**N in the number of
    token columns. In a browser that hangs one tab; here it blocks a
    Girder request thread for every user, and filenames with many
    underscore-separated tokens are ordinary -- measured on the pure
    helper, 20 tokens took 9s and each extra token doubles it.

    Two bounds make that tractable **without changing what is returned**:

    1. A column with a single distinct value multiplies the product by 1,
       so any matching combination containing it also matches without it.
       That smaller combination is enumerated first (the search walks
       sizes in increasing order), so the minimal match never contains
       one. Only the empty combination could be the exception, and it is
       both never enumerated and only a match when there is one row --
       hence the ``total_rows > 1`` guard.
    2. ``_assign_unique_categorizations`` discards any result with more
       than ``len(_BASE_CATEGORIES)`` columns, returning ``[]`` -- exactly
       what "no match" produces. Searching past that size can only spend
       time to reach the same answer.

    Distinct counts are computed once per column rather than once per
    combination, which the original recomputed O(2**N) times.
    """
    total_rows = len(rows)
    counts = {col: _distinct_count(rows, col) for col in columns}
    if total_rows > 1:
        columns = [col for col in columns if counts[col] > 1]

    max_size = min(len(columns), len(_BASE_CATEGORIES))
    for size in range(1, max_size + 1):
        for combination in _get_combinations(columns, size):
            product = 1
            for col in combination:
                product *= counts[col]
            if product == total_rows:
                return combination
    return []


def _find_common_substring(tokens):
    """Positional common substring over ``tokens`` with ``"_"`` where the
    characters differ.

    JS reads ``tokens[0].length`` as the loop bound and treats
    out-of-range / undefined characters as mismatches. If ``tokens[0]`` is
    ``None`` (a ragged first row) JS would throw; here we treat it as an
    empty string, which categorizes as "chan" -- fixtures avoid this case.
    """
    first = tokens[0]
    if first is None:
        return ""
    common = ""
    for i in range(len(first)):
        current = first[i]
        matches = True
        for token in tokens:
            char = token[i] if (token is not None and i < len(token)) \
                else None
            if char != current:
                matches = False
                break
        common += current if matches else "_"
    return common


def _categorize_substring(substring):
    """Map a common substring to a category via case-insensitive triggers."""
    lower = substring.lower()
    for category, triggers in TRIGGERS_PER_CATEGORY.items():
        if any(trigger in lower for trigger in triggers):
            return category
    return "chan"


def _categorize_column(rows, col):
    """Guess the category for a single token column (all rows, row order)."""
    tokens = [_column_value(row, col) for row in rows]

    if all(_XY_PATTERN.match(_js_str(token)) for token in tokens):
        return "xy"

    if all(not _DIGIT_PATTERN.search(_js_str(token)) for token in tokens):
        return "chan"

    return _categorize_substring(_find_common_substring(tokens))


def _assign_unique_categorizations(rows, minimal_columns):
    """Categorize each minimal column and resolve duplicate categories."""
    # Guard mirrors the JS check on the number of complementary lists.
    if len(minimal_columns) > len(_BASE_CATEGORIES):
        return []

    assigned = [_categorize_column(rows, col) for col in minimal_columns]

    for i in range(len(assigned)):
        while assigned.index(assigned[i]) != i:
            next_available = next(
                (cat for cat in _BASE_CATEGORIES if cat not in assigned),
                None,
            )
            if next_available is None:
                return []
            assigned[i] = next_available

    return assigned


def _structured_assignments(rows, minimal_columns, assignments):
    """Build the ``IVariableGuess`` records for each assigned column."""
    output = []
    for i, category in enumerate(assignments):
        col = minimal_columns[i]

        # Distinct values (first occurrence), then JS default sort.
        values = list(dict.fromkeys(_column_value(row, col) for row in rows))
        values.sort(key=lambda value: (value is None, value))

        token_to_index = {value: idx for idx, value in enumerate(values)}

        value_idx_per_filename = {}
        for row in rows:
            value_idx_per_filename[row[0]] = token_to_index[
                _column_value(row, col)
            ]

        output.append({
            "guess": _ASSIGNMENT_TO_LETTER[category],
            "values": values,
            "valueIdxPerFilename": value_idx_per_filename,
        })

    return output


def collect_filename_metadata(filenames):
    """Port of ``collectFilenameMetadata2``.

    Args:
        filenames: list of item names.

    Returns:
        A list of dicts, each shaped like::

            {"guess": "XY" | "Z" | "T" | "C",
             "values": [...],
             "valueIdxPerFilename": {name: index}}

        Returns ``[]`` when no spanning columns are found or a unique
        categorization cannot be assigned (mirrors the silent JS paths).
    """
    if not filenames:
        return []

    rows = _tokenize(filenames)
    max_tokens = max(len(row) for row in rows)
    # Token columns are indices 1..max_tokens-1 ("Token 1" .. "Token N").
    columns = list(range(1, max_tokens))

    minimal_columns = _find_minimal_spanning_columns(rows, columns)
    assignments = _assign_unique_categorizations(rows, minimal_columns)
    return _structured_assignments(rows, minimal_columns, assignments)
