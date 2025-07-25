from setuptools import setup, find_packages

with open('README.rst') as readme_file:
    readme = readme_file.read()

setup(
    name='girder_claude_chat',
    author='Arjun Raj',
    author_email='arjunrajlab@gmail.com',
    classifiers=[
        'Development Status :: 2 - Pre-Alpha',
        'License :: OSI Approved :: Apache Software License',
        'Natural Language :: English',
        'Programming Language :: Python :: 3',
        'Programming Language :: Python :: 3.6',
        'Programming Language :: Python :: 3.7',
        'Programming Language :: Python :: 3.8'
    ],
    description='A Girder plugin for Claude chat functionality',
    install_requires=[
        "girder[mount] @ git+https://github.com/girder/girder.git",
        "anthropic"
    ],
    license='Apache Software License 2.0',
    long_description=readme,
    long_description_content_type='text/x-rst',
    include_package_data=True,
    keywords='girder-plugin, claude_chat',
    packages=find_packages(exclude=['test', 'test.*']),
    url='https://github.com/girder/girder_claude_chat',
    version='0.1.0',
    zip_safe=False,
    entry_points={
        'girder.plugin': [
            'girder_claude_chat = girder_claude_chat:GirderClaudeChatPlugin'
        ]
    }
)
