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
* Column combinations are considered in the exact order of the JS
  ``getCombinations`` helper (sizes 1..n; for each size the head element
  walks left to right and recurses on the tail). They are walked rather
  than materialized, and bounded -- see
  ``_find_minimal_spanning_columns`` for why each bound cannot change
  which combination is returned.
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
* Error paths are silent (return ``[]`` / skip) with one exception: a
  ragged *leading* row in a spanning column raises ``ValueError``. See
  ``_categorize_column`` for why refusing is the faithful choice there.
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


def _search_combination(columns, counts, total_rows, size):
    """First combination of exactly ``size`` columns whose distinct-count
    product equals ``total_rows``, in the JS helper's emission order
    (lexicographic by column index), or ``None``.

    Walks the choices instead of materializing them -- the eager version
    built every combination up front, which is where the memory went --
    and prunes two ways that cannot skip a match:

    * counts are >= 1, so the product only grows; once a partial product
      exceeds ``total_rows`` no extension can come back down;
    * the final product is the partial product times whole numbers, so it
      can only equal ``total_rows`` if the partial one divides it.

    The divisibility prune is what makes the all-varying case cheap: with
    three files and 120 two-valued columns, every branch dies at depth one
    (3 % 2 != 0) instead of expanding into millions of four-column sets.
    """
    chosen = []

    def walk(start, remaining, product):
        if remaining == 0:
            return product == total_rows
        # Leave room for the columns still to be chosen.
        for index in range(start, len(columns) - remaining + 1):
            column = columns[index]
            nextProduct = product * counts[column]
            if nextProduct > total_rows or total_rows % nextProduct:
                continue
            chosen.append(column)
            if walk(index + 1, remaining - 1, nextProduct):
                return True
            chosen.pop()
        return False

    return list(chosen) if walk(0, size, 1) else None


def _find_minimal_spanning_columns(rows, columns):
    """First column combination whose distinct-value product equals the
    number of rows, in JS enumeration order.

    The frontend searches every subset, which is 2**N in the number of
    token columns. In a browser that hangs one tab; here it blocks a
    Girder request thread for every user, and filenames with many
    underscore-separated tokens are ordinary -- measured on the pure
    helper, 20 tokens took 9s and each extra token doubles it.

    Three bounds make that tractable **without changing what is
    returned**:

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
    3. Within a size, ``_search_combination`` prunes on the running
       product (see there). Bound 1 alone left the all-varying case
       expensive -- 120 two-valued columns still built every one- to
       four-column set, ~2s and ~900MB -- because nothing was constant to
       drop.

    Distinct counts are computed once per column rather than once per
    combination, which the original recomputed O(2**N) times.
    """
    total_rows = len(rows)
    counts = {col: _distinct_count(rows, col) for col in columns}
    if total_rows > 1:
        columns = [col for col in columns if counts[col] > 1]

    max_size = min(len(columns), len(_BASE_CATEGORIES))
    for size in range(1, max_size + 1):
        combination = _search_combination(columns, counts, total_rows, size)
        if combination is not None:
            return combination
    return []


def _find_common_substring(tokens):
    """Positional common substring over ``tokens`` with ``"_"`` where the
    characters differ.

    JS reads ``tokens[0].length`` as the loop bound and treats
    out-of-range / undefined characters as mismatches. ``tokens[0]`` being
    ``None`` is rejected by the caller before we get here, because JS
    throws on it -- see ``_categorize_column``.
    """
    first = tokens[0]
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

    if tokens[0] is None:
        # This is exactly where JS reads `tokens[0].length` and throws
        # `TypeError: Cannot read properties of undefined (reading
        # 'length')` -- verified against the real collectFilenameMetadata2.
        # That aborts the configuration screen, so the UI cannot configure
        # such a folder at all. Returning "" instead (which categorizes as
        # "chan") made this port *more permissive* than the component: it
        # produced a variable whose values contain None, i.e. a channel
        # literally named null in the written configuration. Refuse, with a
        # message that beats the frontend's raw TypeError.
        raise ValueError(
            'Filenames do not have a consistent number of parts: "%s" has '
            "no part %d, but that part is one of the ones that "
            "distinguishes the files. Rename the files so that every name "
            "has the same structure." % (rows[0][0], col)
        )

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
