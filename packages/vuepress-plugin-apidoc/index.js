const { logger } = require('@vuepress/shared-utils');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');

const { linkConverterPlugin, typeAutolink, vueComponentPatch } = require('./lib/utils/markdown');
const { metadataService, getLinkForKeyPath } = require('./lib/utils/metadata');

const execAsync = promisify(exec);

let processed = {};
const versions = [];

/**
 * Titanium API reference documentation plugin
 */
module.exports = (options = {}, context) => {
  const pluginName = 'titanium/apidoc';

  const versionsFilePath = path.join(context.sourceDir, '.vuepress', 'versions.json');
  if (fs.existsSync(versionsFilePath)) {
    versions.splice(0, 0, ...JSON.parse(fs.readFileSync(versionsFilePath).toString()));
  }
  metadataService.loadMetadata(context, versions);

  return {
    name: pluginName,

    plugins: [
      [
        '@vuepress/register-components',
        {
          componentsDir: path.join(__dirname, 'global-components')
        }
      ]
    ],

    alias: {
      '@apidoc': __dirname
    },

    /**
     * Extend page data of pages under /api/ with metadata key, process the metadata
     * required by that page and then adds additonal headers to the page
     *
     * @param {Page} page
     */
    extendPageData(page) {
      if (!/^(\/[\w.\-]+)?\/api\//.test(page.regularPath)) {
        return;
      }

      page.frontmatter.layout = 'ApiLayout';
      page.frontmatter.sidebarDepth = 0;

      const typeName = page.frontmatter.metadataKey || page.title;
      const version = page.version || 'next';
      const metadata = metadataService.findMetadata(typeName, version);

      if (!metadata) {
        logger.warn(`no metadata found for API page ${page.path}`);
        metadataService.currentPage = null;
        return;
      }

      page.metadataKey = typeName;
      page.frontmatter.pageClass = 'api-page';


      if (processed[version] && processed[version][typeName]) {
        const metadataProcessor = processed[version][typeName];
        metadataProcessor.appendAdditionalHeaders(page);
        metadataService.currentPage = null;
        return;
      }

      const metadataProcessor = new MetadataProcessor(context, version);
      metadataProcessor.transoformMetadataAndCollectHeaders(metadata);
      metadataProcessor.appendAdditionalHeaders(page);

      if (!processed[version]) {
        processed[version] = {}
      }
      processed[version][typeName] = metadataProcessor;
      metadataService.currentPage = null;
    },

    /**
     * Create dynamic module with processed metadata which is used in webpack server entry
     * to pre-populate the store
     */
    async clientDynamicModules() {
      // @fixme: we can only write one dynamic module per plugin so we need to do
      // the other one manually
      const typeLinks = {};
      for (const version of metadataService.versions) {
        Object.keys(metadataService.metadata[version]).forEach(name => {
          if (!typeLinks[name]) {
            typeLinks[name] = getLinkForKeyPath(name, '/').path;
          }
        });
      }
      await context.writeTemp(
        `dynamic/type-links.js`,
        `/**
 * Generated by "${pluginName}"
 */
export default ${JSON.stringify(typeLinks)}\n\n`.trim()
      );

      return {
        name: 'metadata.js',
        content: `export default ${JSON.stringify(metadataService.metadata)}`
      };
    },

    /**
     * Enhance the Koa dev server and serve api metadata directly from memory
     */
    beforeDevServer (app) {
      app.use((req, res, next) => {
        if (!req.accepts('json')) {
          res.status(406);
          return;
        }

        const metadataRoutePattern = /\/([\w.]+)\/([\w.]+).json$/;
        const match = req.path.match(metadataRoutePattern);
        if (!match) {
          return next();
        }

        const version = match[1]
        const typeName = match[2];
        const metadata = findMetadataWithLowerCasedKey(typeName, version);
        if (!metadata) {
          return next();
        }

        res.json(metadata);
      });
    },

    /**
     * Add various plugins to markdown-it that are required to properly render links
     * between types.
     */
    chainMarkdown(config) {
      config
        .plugin('convert-type-link')
        .use(linkConverterPlugin);

      config
        .plugin('type-autolink')
        .use(typeAutolink)

      config
        .plugin('vue-component-patch')
        .use(vueComponentPatch)
    },

    /**
     * Replace webpack entry scripts to support Vuex which serves as the metadata store
     */
    chainWebpack (config, isServer) {
      if (isServer) {
        config
        .entry('app')
          .clear()
          .add(path.resolve(__dirname, 'lib/webpack/serverEntry.js'));
      } else {
        config
        .entry('app')
          .clear()
          .add(path.resolve(__dirname, 'lib/webpack/clientEntry.js'));
      }
    },

    /**
     * Split metadata per type and generate a JSON file for each one that gets
     * loaded by Vuex on subsequent page loads once Vue takes over on the client.
     */
    async generated () {
      // @todo check context.markdown.$data.typeLinks for existence

      const tempMetadataPath = path.resolve(context.tempPath, 'metadata');
      fs.ensureDirSync(tempMetadataPath);
      for (const version in processed) {
        fs.ensureDirSync(path.join(tempMetadataPath, version));
        for (const typeName in processed[version]) {
          const metadata = metadataService.findMetadata(typeName, version);
          const destPath = path.join(tempMetadataPath, version, `${typeName.toLowerCase()}.json`);
          fs.writeFileSync(destPath, JSON.stringify(metadata));
        }
      }

      await fs.copy(tempMetadataPath, path.resolve(context.outDir, 'metadata'));
    },

    /**
     * Extends the VuePress CLI with a new command to easily generate API metadata from
     * a set of input directories.
     */
    extendCli(cli) {
      cli
        .command('metadata <targetDir> [...inputPaths]', 'Generate required metadata for the API reference docs')
        .option('-o <dir>', 'Output directory. Defaults to <targetDir>/api/')
        .action(async (targetDir, inputPaths, options) => {
          if (inputPaths.length === 0) {
            throw new Error('Please specify at least one path to a folder containing API docs.')
          }

          const outputPath = options.o ? path.resolve(options.o) : path.resolve(context.sourceDir, 'api');
          const docgenMainScript = require.resolve('titanium-docgen');
          const command = [
            'node',
            docgenMainScript,
            '-f', 'json-raw',
            inputPaths.shift(),
            ...inputPaths.reduce((acc, cur) => {
              acc.push('-a', cur)
              return acc;
            }, []),
            '-o', outputPath
          ];
          logger.wait('Generating API metadata...');
          try {
            await execAsync(command.join(' '));
            logger.success(`Done! Metadata generated to ${outputPath}`);
          } catch (e) {
            logger.error('Failed to generate API metadata.');
            throw e;
          }
        });
    }
  }
};

function findMetadataWithLowerCasedKey(lowerCasedTypeName, version) {
  const typesMetadata = metadataService.metadata[version];
  for(let typeName in typesMetadata) {
    if (typeName.toLowerCase() === lowerCasedTypeName) {
      return typesMetadata[typeName];
    }
  }

  return null;
}

/**
 * Processor for metadata that powers API reference pages.
 *
 * Applies transforms to the Metadata so we can properly use it in our VuePress environment.
 * Also collects additionals headers required for the sidebar navigation on API pages.
 *
 * Each instance of this processor can only be used to transform one single type.
 */
class MetadataProcessor {
  constructor(context, version) {
    this.markdown = context.markdown;
    this.base = context.base;
    this.version = version;
    this.additionalHeaders = [];
    this.constantNamingPattern = /^[A-Z0-9_]+$/;
    this.hasConstants = false;
  }

  /**
   * Prepares metadata for usage in VuePress and collects additional headers
   * which will be inserted manually into the page. Changes to the metadata
   * will be written back into the given object.
   */
  transoformMetadataAndCollectHeaders(metadata) {
    delete metadata.description;
    delete metadata.examples;

    this.filterInheritedMembers(metadata);

    this.sortByName(metadata.properties);
    this.sortByName(metadata.methods);

    // We need to temporarily disbale the vue router link rule since the rendered markdown
    // will be directly inserted via v-html so Vue components won't work
    const vueRouterLinkRule = this.markdown.renderer.rules.link_open;
    this.markdown.renderer.rules.link_open = function(tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    metadata.summary = this.renderMarkdown(metadata.summary);
    this.transformMembersAndCollectHeaders('properties', metadata);
    this.transformMembersAndCollectHeaders('methods', metadata);
    this.transformMembersAndCollectHeaders('events', metadata);
    this.markdown.renderer.rules.link_open = vueRouterLinkRule;

    this.splitPropertiesAndConstants(metadata);
  }

  appendAdditionalHeaders(page) {
    page.headers = (page.headers || []).concat(this.additionalHeaders);
    if (this.hasConstants) {
      page.headers.push({
        level: 2,
        title: 'Constants',
        slug: 'constants'
      });
    }
  }

  filterInheritedMembers(metadata) {
    const filterInherited = member => {
      if (member.inherits && member.inherits !== metadata.name) {
        return false;
      }

      return true;
    }
    metadata.properties = metadata.properties.filter(filterInherited);
    metadata.methods = metadata.methods.filter(filterInherited);
    metadata.events = metadata.events.filter(filterInherited);
  }

  transformMembersAndCollectHeaders(memberType, metadata) {
    const membersMetadata = metadata[memberType];
    if (!membersMetadata || membersMetadata.length === 0) {
      return;
    }

    let headers = [];
    membersMetadata.forEach((memberMetadata, index) => {
      if (memberMetadata.summary) {
        membersMetadata[index].summary = this.renderMarkdown(memberMetadata.summary);
      }
      if (memberMetadata.description) {
        membersMetadata[index].description = this.renderMarkdown(memberMetadata.description);
      }
      if (memberMetadata.examples && memberMetadata.examples.length) {
        let combinedExamplesMarkdown = '#### Examples\n\n';
        memberMetadata.examples.forEach(example => {
          combinedExamplesMarkdown += `##### ${example.description}\n${example.code}`;
        });
        memberMetadata.examples = this.renderMarkdown(combinedExamplesMarkdown);
      }
      if (memberMetadata.deprecated && memberMetadata.deprecated.notes) {
        memberMetadata.deprecated.notes = this.renderMarkdown(memberMetadata.deprecated.notes);
      }
      if (memberMetadata.returns && memberMetadata.returns.summary) {
        memberMetadata.returns.summary = this.renderMarkdown(memberMetadata.returns.summary);
      }

      if (memberType === 'properties' && this.constantNamingPattern.test(memberMetadata.name)) {
        this.hasConstants = true;
        return;
      }

      headers.push({
        level: 3,
        title: memberMetadata.name,
        slug: memberMetadata.name.toLowerCase()
      });
    });
    if (headers.length) {
      this.additionalHeaders.push({
        level: 2,
        title: memberType.charAt(0).toUpperCase() + memberType.slice(1),
        slug: memberType
      });
      this.additionalHeaders = this.additionalHeaders.concat(headers);
    }
  }

  renderMarkdown(markdownString) {
    // @FIXME: This can be removed once we have a means to generate client dynamic modules
    markdownString = this.rewriteTypeLinks(markdownString);
    const { html } = this.markdown.render(markdownString);
    return html;
  }

  rewriteTypeLinks(markdownString) {
    const customLinkPattern = /<([^>\/]+)>/g;
    const mdLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const version = (versions.length === 0 || this.version === versions[0]) ? null : this.version;

    markdownString = markdownString.replace(customLinkPattern, (match, linkValue) => {
      const link = getLinkForKeyPath(linkValue, this.base, version);
      if (link) {
        return `[${link.name}](${link.path})`;
      }
      return match;
    });

    markdownString = markdownString.replace(mdLinkPattern, (match, linkText, linkValue) => {
      const link = getLinkForKeyPath(linkValue, this.base, version);
      if (link) {
        return `[${link.name}](${link.path})`;
      }
      return match;
    });

    return markdownString;
  }

  sortByName(unsortedArray) {
    if (!unsortedArray) {
      return;
    }
    unsortedArray.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });
  }

  splitPropertiesAndConstants(metadata) {
    const properties = [];
    const constants = [];
    metadata.properties.forEach(property => {
      if (this.constantNamingPattern.test(property.name)) {
        constants.push(property);
      } else {
        properties.push(property);
      }
    });
    metadata.properties = properties;
    metadata.constants = constants;
  }
}