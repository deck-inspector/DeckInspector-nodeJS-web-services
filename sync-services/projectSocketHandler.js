"use strict";

const projectService = require('../service/projectService');
const { ObjectId } = require('mongodb');

/**
 * Handles CRUD operations for projects based on socket messages.
 * @param {Socket} socket - The socket instance for communication.
 * @param {Server} io - The Socket.IO server instance for broadcasting.
 */
module.exports = function projectSocketHandler(socket, io) {
    console.log(`Socket connected: ${socket.id}`);

    // Handle "createProject" event
    socket.on('createProject', async (data, callback) => {
        try {
            const { name, description, address, createdBy, url, assignedTo, projecttype, editedat, formId, companyIdentifier } = data;

            if (!name) {
                return callback({ success: false, message: "Project name is required." });
            }
            const newProject = {
                name,
                description,
                address,
                createdby: createdBy,
                url,
                lasteditedby: createdBy,
                assignedto: assignedTo,
                editedat: new Date(editedat).toISOString(),
                children: [],
                projecttype,
                createdat: new Date(editedat).toISOString(),
                iscomplete: false,
                isInvasive: false,
                companyIdentifier,
                formId: formId == null ? null : ObjectId(formId)
            };

            const result = await projectService.addProject(newProject);
            callback({ success: true, data: result });
            io.emit('projectCreated', result); // Broadcast to all clients
        } catch (error) {
            console.error('Error creating project:', error);
            callback({ success: false, message: 'Error creating project.' });
        }
    });

    // Handle "updateProject" event
    socket.on('updateProject', async (data, callback) => {
        try {
            const { projectId, updates } = data;

            if (!projectId || !updates) {
                return callback({ success: false, message: "Project ID and updates are required." });
            }

            if (updates.formId) {
                updates.formId = updates.formId == null ? null : ObjectId(updates.formId);
            }

            const result = await projectService.editProject(projectId, updates);
            callback({ success: true, data: result });
            io.emit('projectUpdated', result); // Broadcast to all clients
        } catch (error) {
            console.error('Error updating project:', error);
            callback({ success: false, message: 'Error updating project.' });
        }
    });

    // Handle "deleteProject" event
    socket.on('deleteProject', async (projectId, callback) => {
        try {
            if (!projectId) {
                return callback({ success: false, message: "Project ID is required." });
            }

            const result = await projectService.archiveProject(projectId);
            callback({ success: true, data: result });
            io.emit('projectDeleted', { projectId }); // Broadcast to all clients
        } catch (error) {
            console.error('Error deleting project:', error);
            callback({ success: false, message: 'Error deleting project.' });
        }
    });

    // Handle "getProjectById" event
    socket.on('getProjectById', async (projectId, callback) => {
        try {
            if (!projectId) {
                return callback({ success: false, message: "Project ID is required." });
            }

            const result = await projectService.getProjectById(projectId);
            callback({ success: true, data: result });
        } catch (error) {
            console.error('Error fetching project by ID:', error);
            callback({ success: false, message: 'Error fetching project by ID.' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
};