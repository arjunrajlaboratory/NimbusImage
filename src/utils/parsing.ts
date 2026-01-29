import { DataFrame } from "dataframe-js";
import { logError } from "@/utils/log";

/** Pattern used to split filenames into tokens (underscores, dots, slashes) */
export const filenameDelimiterPattern = /[_\.\/]/;

function processFilenamesDF(filenames: string[]): DataFrame {
  // Tokenize each filename
  const tokenizedData: string[][] = filenames.map((filename) => {
    const tokens = filename.split(filenameDelimiterPattern);
    return [filename, ...tokens];
  });

  // Find the maximum number of tokens for column naming
  const maxTokens = Math.max(...tokenizedData.map((row) => row.length));

  // Define column names
  const columns = [
    "Filename",
    ...Array.from({ length: maxTokens - 1 }, (_, i) => `Token ${i + 1}`),
  ];

  // Create a DataFrame
  const df = new DataFrame(tokenizedData, columns);

  // Sort by Filename
  const sortedDf = df.sortBy("Filename");

  return sortedDf;
}

function findMinimalSpanningColumns(df: DataFrame): string[] {
  const allColumns: string[] = df.listColumns();
  // Exclude the "Filename" column
  const columns = allColumns.filter((column) => column !== "Filename");
  const totalRows = df.count();

  // Helper function to compute the number of elements in the Cartesian product of arrays
  const cartesianProductSize = <T>(arrays: T[][]): number =>
    arrays.reduce((size, elements) => size * elements.length, 1);

  // For increasing sizes of combinations...
  for (let i = 1; i <= columns.length; i++) {
    const columnCombinations = getCombinations(columns, i); // Get all i-sized combinations of columns

    for (const combination of columnCombinations) {
      const uniqueValueArrays = combination.map((col) =>
        df.distinct(col).toArray(col),
      );

      // Compute the Cartesian product size
      const size = cartesianProductSize(uniqueValueArrays);

      if (size === totalRows) {
        return combination;
      }
    }
  }

  return [];
}

// Helper function to get combinations of elements (columns in our case)
function getCombinations<T>(elements: T[], size: number): T[][] {
  if (size === 1) {
    return elements.map((e) => [e]);
  }

  let combinations: T[][] = [];
  for (let i = 0; i < elements.length - size + 1; i++) {
    const head = elements[i];
    const tailCombinations = getCombinations(elements.slice(i + 1), size - 1);
    combinations = [
      ...combinations,
      ...tailCombinations.map((tc) => [head, ...tc]),
    ];
  }
  return combinations;
}

function findComplementaryColumns(
  df: DataFrame,
  specifiedColumn: string,
): string[] {
  const specifiedColumnDistinctCount = df.distinct(specifiedColumn).count();
  const allColumns = df.listColumns();
  const complementaryColumns: string[] = [];

  for (const testColumn of allColumns) {
    if (testColumn === specifiedColumn) continue; // Skip the column if it's the same as the specified column

    const testColumnDistinctCount = df.distinct(testColumn).count();

    // Create a combined column and count distinct values
    const combined = df.withColumn(
      "combined",
      ((row: any) =>
        row.get(specifiedColumn) + "_" + row.get(testColumn)) as any,
    );
    const combinedDistinctCount = combined.distinct("combined").count();

    if (
      combinedDistinctCount === specifiedColumnDistinctCount &&
      combinedDistinctCount === testColumnDistinctCount
    ) {
      complementaryColumns.push(testColumn);
    }
  }

  return complementaryColumns;
}

function findAllComplementaryColumns(
  df: DataFrame,
  specifiedColumns: string[],
): string[][] {
  const results: string[][] = [];

  for (const column of specifiedColumns) {
    const complementary = findComplementaryColumns(df, column);
    results.push([column, ...complementary]); // Add the specified column to the front
  }

  return results;
}

function findCommonSubstring(tokens: string[]): string {
  // Assuming all tokens have the same length
  const tokenLength = tokens[0].length;
  let commonSubstring = "";

  for (let i = 0; i < tokenLength; i++) {
    const currentChar = tokens[0][i];
    if (tokens.every((token) => token[i] === currentChar)) {
      commonSubstring += currentChar;
    } else {
      // TODO: have to decide whether to keep placeholders or just remove
      commonSubstring += "_"; // placeholder for non-matching characters
    }
  }

  return commonSubstring;
}

function findColumnCommonSubstring(
  df: DataFrame,
  specifiedColumn: string,
): string {
  // Ensure the column exists in the DataFrame
  const columns = df.listColumns();
  if (!columns.includes(specifiedColumn)) {
    logError(`Column '${specifiedColumn}' does not exist in the DataFrame.`);
    return "";
  }

  const tokens: string[] = df.toArray(specifiedColumn);

  // Check if tokens array is defined and non-empty
  if (!tokens || !tokens.length) {
    logError(`Tokens for column '${specifiedColumn}' are undefined or empty.`);
    return "";
  }

  return findCommonSubstring(tokens);
}

export const triggersPerCategory = {
  z: ["z", "slice"],
  xy: ["well", "stage", "pos"],
  chan: ["chan", "channel", "fp", "ch"],
  t: ["t", "time", "sec", "msec", "ms", "d", "m", "hr", "h"],
};

function categorizeSubstring(substring: string): string {
  // Convert the substring to lowercase for case-insensitive matching
  const lowerSub = substring.toLowerCase();

  for (const [category, triggers] of Object.entries(triggersPerCategory)) {
    if (triggers.some((trigger) => lowerSub.includes(trigger))) {
      return category;
    }
  }

  // If no match found, default to "chan"
  return "chan";
}

function categorizeColumns(df: DataFrame, columnNames: string[]): string {
  // Helper regex pattern to detect a single letter followed by a single digit
  const xyPattern = /^[A-Za-z]\d{1,2}$/;

  const firstColumn = columnNames[0];

  const tokens: string[] = df.toArray(firstColumn);

  // If all tokens are of the pattern "A7", "C3", etc.
  if (tokens.every((token) => xyPattern.test(token))) {
    return "xy";
  }

  // If none of the tokens in the column contain numerals
  if (tokens.every((token) => !/\d/.test(token))) {
    return "chan";
  }

  // Find common substring
  const commonStr = findColumnCommonSubstring(df, firstColumn);

  // Use the common substring to determine the category
  return categorizeSubstring(commonStr);
}

function assignUniqueCategorizations(
  df: DataFrame,
  allComplementaryLists: string[][],
): string[] {
  // Base list of categorizations
  const baseCategorizations = ["chan", "xy", "z", "t"];

  // Initial check
  if (allComplementaryLists.length > baseCategorizations.length) {
    logError(
      "Error: Too many lists in allComplementaryLists to assign unique categorizations.",
    );
    return [];
  }

  // Step 2: Initial assignment
  const assignedCategorizations: string[] = [];
  for (const list of allComplementaryLists) {
    assignedCategorizations.push(categorizeColumns(df, list));
  }

  // Step 3: Resolve conflicts
  for (let i = 0; i < assignedCategorizations.length; i++) {
    while (assignedCategorizations.indexOf(assignedCategorizations[i]) !== i) {
      // If conflict exists
      const nextAvailableCategory = baseCategorizations.find(
        (cat) => !assignedCategorizations.includes(cat),
      );
      if (nextAvailableCategory) {
        assignedCategorizations[i] = nextAvailableCategory;
      } else {
        logError("Error: Unable to find a unique categorization.");
        return [];
      }
    }
  }

  return assignedCategorizations; // Return the results
}

function structuredAssignments(
  df: DataFrame,
  allComplementaryLists: string[][],
  assignments: string[],
) {
  const output: IVariableGuess[] = [];

  const assignmentToLetterMap: { [key: string]: TDimensions } = {
    chan: "C",
    t: "T",
    xy: "XY",
    z: "Z",
  };

  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const list = allComplementaryLists[i];

    // Ensure the column from the list exists in the DataFrame
    if (!df.listColumns().includes(list[0])) {
      logError(`Column '${list[0]}' does not exist in the DataFrame.`);
      continue;
    }

    // Get the tokens for the column and sort them alphabetically
    const tokens: string[] = df.distinct(list[0]).toArray(list[0]);
    tokens.sort();

    // Create a map for tokens to their respective integer values
    const tokenToIntMap: { [key: string]: number } = {};
    tokens.forEach((token, index) => {
      tokenToIntMap[token] = index;
    });

    // Structure the data
    const structuredData: IVariableGuess = {
      guess: assignmentToLetterMap[assignment],
      valueIdxPerFilename: {},
      values: tokens,
    };

    const mappedRows = df.select("Filename", list[0]);

    const valueIdxPerFilename: { [Filename: string]: number } = {};
    const rowsArray = mappedRows.toArray();

    // Loop over each row
    for (const row of rowsArray) {
      const Filename = row[0]; // The first element is the filename
      const token = row[1]; // The second element is the token

      // Use tokenToIntMap to fetch the index value for the token
      valueIdxPerFilename[Filename] = tokenToIntMap[token];
    }

    structuredData.valueIdxPerFilename = valueIdxPerFilename;

    output.push(structuredData);
  }

  return output;
}

export type TDimensions = "XY" | "Z" | "T" | "C";

export interface IVariableGuess {
  guess: TDimensions; // Guessed dimension
  values: string[]; // All the values for this dimension (a list of unique strings)
  valueIdxPerFilename: {
    [key: string]: number; // Index of the value for each filename
  };
}

export function collectFilenameMetadata2(filenames: string[]) {
  const df = processFilenamesDF(filenames);
  const minimalColumns = findMinimalSpanningColumns(df);
  const allComplementaryLists = findAllComplementaryColumns(df, minimalColumns);
  const assignments = assignUniqueCategorizations(df, allComplementaryLists);
  return structuredAssignments(df, allComplementaryLists, assignments);
}
