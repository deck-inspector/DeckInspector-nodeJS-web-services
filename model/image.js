"use strict";
// Post-upload URL rewrite: after a photo is uploaded to Azure blob storage
// (routes/images-endpoint.js), this stamps the blob URL onto the entity that
// owns the photo. REWRITTEN for Couchbase (Aug 17, 2026) - the old version
// still wrote to MongoDB, which is gone since the migration, so every mobile
// photo sync uploaded the blob fine but the section/project docs kept the
// device-local path (e.g. "section/Walkway /CAP_....jpg") and the web app
// showed broken photos ("photo sync is not working", David, 1518 E. 51st St).
const couchbase = require("../database/couchbase");

function basename(p) {
    const s = String(p || "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return (i >= 0 ? s.slice(i + 1) : s).trim().toLowerCase();
}
function isHttp(u) { return /^https?:\/\//i.test(String(u || "")); }

// Update the matching child entry (by id) on a parent doc's children array,
// if the parent keeps one. Best effort - never throws.
async function updateChildUrl(collection, parentId, childId, imageUrl) {
    try {
        if (!parentId) return;
        const doc = await collection.get(parentId);
        if (!doc || !doc.content || !Array.isArray(doc.content.children)) return;
        let touched = false;
        const children = doc.content.children.map(function (ch) {
            const cid = ch && (ch.id || ch._id);
            if (cid === childId) { touched = true; return Object.assign({}, ch, { url: imageUrl }); }
            return ch;
        });
        if (touched) await collection.upsert(parentId, Object.assign({}, doc.content, { children }));
    } catch (e) { /* parent may not track children - fine */ }
}

var updateImageURL = async function (id, imageUrl, lasteditedby, editedat, type, parenttype) {
    try {
        switch (type) {
            case "project": {
                const coll = couchbase.Projects;
                const doc = await coll.get(id);
                await coll.upsert(id, Object.assign({}, doc.content, { url: imageUrl, lasteditedby, editedat }));
                break;
            }
            case "subproject": {
                const coll = couchbase.SubProjects;
                const doc = await coll.get(id);
                await coll.upsert(id, Object.assign({}, doc.content, { url: imageUrl, lasteditedby, editedat }));
                await updateChildUrl(couchbase.Projects, doc.content.parentid, id, imageUrl);
                break;
            }
            case "location": {
                const coll = couchbase.Locations;
                const doc = await coll.get(id);
                await coll.upsert(id, Object.assign({}, doc.content, { url: imageUrl, lasteditedby, editedat }));
                const parentColl = (parenttype === "project") ? couchbase.Projects : couchbase.SubProjects;
                await updateChildUrl(parentColl, doc.content.parentid, id, imageUrl);
                break;
            }
            case "section": {
                const coll = couchbase.Sections;   // VisualSection
                const doc = await coll.get(id);
                const section = doc.content;
                let images = Array.isArray(section.images) ? section.images.slice() : [];
                // drop the device-local entry this blob replaces. Blob names are
                // "<container>-<originalFileName>", local entries end in just the
                // file name - so match on equal name OR container-prefixed name.
                const blobBase = basename(decodeURIComponent(imageUrl));
                images = images.filter(function (img) {
                    if (isHttp(img)) return true;
                    const b = basename(img);
                    return b !== blobBase && !blobBase.endsWith("-" + b);
                });
                if (images.indexOf(imageUrl) === -1) images.push(imageUrl);
                const updated = Object.assign({}, section, { images, lasteditedby, editedat });
                await coll.upsert(id, updated);
                // keep the parent location's copy of this section fresh (url + count)
                try {
                    const locColl = couchbase.Locations;
                    const locDoc = await locColl.get(section.parentid);
                    if (locDoc && locDoc.content && Array.isArray(locDoc.content.sections)) {
                        let touched = false;
                        const sections = locDoc.content.sections.map(function (s) {
                            const sid = s && (s.id || s._id);
                            if (sid === id) { touched = true; return Object.assign({}, s, { url: imageUrl, count: images.length }); }
                            return s;
                        });
                        if (touched) await locColl.upsert(section.parentid, Object.assign({}, locDoc.content, { sections }));
                    }
                } catch (e) { /* location copy is best effort */ }
                break;
            }
            default:
                return { error: { code: 400, message: "Unknown entity type: " + type } };
        }
        return { data: { message: "Image url updated successfully.", code: 201 } };
    } catch (err) {
        console.error("updateImageURL failed:", type, id, err && err.message);
        return { error: { code: 500, message: "Error fetching entity or applying changes.", errordata: err && err.message } };
    }
};

module.exports = {
    updateImageURL
};
