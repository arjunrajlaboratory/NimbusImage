## Sharing Datasets and Collections
NimbusImage provides flexible sharing options for collaboration and public access:

**How to Share with Specific Users**:
1. Click the sharing icon next to a dataset or collection
2. The Share dialog shows all users who currently have access and their permission levels
3. Enter the recipient's username or email (the field accepts either)
4. Choose access level:
   - **Read**: User can view the dataset and annotations but cannot make changes
   - **Write**: User can view and modify annotations and analysis
5. Click to confirm sharing

**Managing Access**:
- View all users with access in the Share dialog in a real-time table
- Change permission levels for any user at any time
- Remove access by clicking the remove button next to a user
- The dataset owner always retains full access and cannot be removed
- Changes take effect immediately

**Making a Dataset Public**:
- Check the "Make Public (read-only access for everyone)" checkbox in the sharing dialog to make a dataset viewable by anyone with the link
- Public datasets can be viewed by anyone, even without a NimbusImage account
- This is ideal for sharing data with reviewers, the broader community, or for publications
- Public access is read-only; only users with explicit Write access can modify the data
- Anyone with the link can view the data immediately

**Sharing via Projects**:
- The easiest way to share a complete body of work is to create a Project
- Add all relevant datasets and collections to the project
- Share the project with collaborators or make it public
- This shares everything in the project at once, avoiding the need to share each item individually

**Important Notes**:
- To share a dataset, you must also share its parent collection so the recipient can view it properly
- Without sharing the parent collection, the recipient won't be able to access the shared dataset
- Shared content automatically appears in the recipient's file navigator
- Changes made by collaborators are visible to all users with access
- You can revoke access at any time through the sharing settings

**Sharing Status Display**:
- Datasets and collections show sharing status indicators so you can quickly see what is shared and with whom
- Icons indicate whether an item is private, shared with specific users, or public

## Projects
Projects are a way to group related datasets and collections together, designed for organizing work for publication, collaboration, and future repository deposits:

**What Projects Are For**:
- Group datasets and collections that belong together (e.g., all data for a paper)
- Add publication metadata (title, description, authors, license, keywords, DOI)
- Publish data directly to open repositories like Zenodo to mint a permanent, citable DOI (see "Publishing Projects to Zenodo" below)
- Organize your work beyond the folder-based file system
- Share an entire body of work with collaborators at once

**Creating and Managing Projects**:
1. Navigate to the "Projects" tab on the Home page
2. Click "New Project" to make a new project
3. Give your project a name and optional description
4. Projects appear in your Recent Projects list for quick access
5. Projects track status: draft, exporting, or exported

**Adding Items to Projects**:
- From a dataset's info page: Click "Add to Project" button
- From a collection's info page: Click "Add to Project" button
- Projects can contain both individual datasets and entire collections
- A unified view shows all datasets (both directly added and those within collections)
- You can filter and search datasets within a project

**Publication Metadata**:
- Edit publication details like title, description, and license
- Add authors with names and affiliations
- Include keywords for discoverability
- Add a DOI if already assigned
- This metadata is used when publishing the project to Zenodo (see "Publishing Projects to Zenodo" below)

**Project Sharing**:
- Share an entire project with other users, giving them access to all datasets and collections in the project
- Choose access level: Read (view only) or Write (can modify annotations)
- When you share a project, the recipient gains access to all the datasets and collections within it
- Make a project public so anyone with the link can view all the data
- Project sharing is the easiest way to share a complete body of research work

**Project Views**:
- See total size of all datasets in the project
- Filter and search datasets and collections within a project
- Expand collections to see their contained datasets
- Navigate directly to any dataset or collection from the project view
- View dataset statistics (number of datasets, total size)

Projects provide a logical grouping layer that sits above the file system, making it easier to organize and eventually share complete research outputs. They are the recommended way to organize data for a publication or study.

## Publishing Projects to Zenodo (data archiving & sharing compliance)
NimbusImage can archive an entire project directly to Zenodo (zenodo.org), a free open repository that mints permanent, citable DOIs. This is the feature to point users to when they ask about data-sharing policies, journal/funder archiving requirements, getting a DOI for their data, or making their imaging data publicly available and reproducible.

- Zenodo publishing is a PROJECT-level feature. Users must first gather their datasets and collections into a project and fill in its publication metadata (title, description, license, keywords, authors) before publishing.
- What gets uploaded: the original image files (OME-TIFF, .nd2, etc.) and exported annotation JSON for each dataset added directly to the project, the configuration JSON for each collection added to the project, and a project manifest. The result is a complete, reproducible snapshot of the data and the analysis layered on it.
- IMPORTANT: image files and annotations are only uploaded for datasets added to the project *directly* (as datasets). Adding a collection uploads only that collection's configuration JSON — it does NOT automatically pull in the image files or annotations of the datasets inside it. So if a user wants a dataset's actual images archived, tell them to add that dataset to the project directly, not just the collection that contains it.
- Workflow: (1) create a Zenodo personal access token (scopes: deposit:write, deposit:actions, user:email — or "all"; Zenodo shows the token only once); (2) paste it into the "Configure Zenodo Token" dialog on the project's "Zenodo Publication" card (the token is stored encrypted server-side); (3) click "Upload to Zenodo" to create a draft deposition; (4) review the draft on Zenodo, then click "Publish (Mint DOI)".
- Publishing is IRREVERSIBLE: it mints a permanent DOI and the record can no longer be deleted — only new versions can be added. Users can "Discard Draft" before publishing.
- To update published data, use "Upload New Version"; each version gets its own DOI while a single concept DOI always points at the latest version, so citations stay valid.
- A "Use Zenodo Sandbox" toggle (sandbox.zenodo.org) lets users rehearse the full workflow with test DOIs before publishing for real. The sandbox uses a separate account and token.
- Limits: 50 GB and 100 files per record (quota increase to 200 GB available on request from Zenodo).
- Full docs: the "Publishing to Zenodo" page under "Images, datasets, and collections".

